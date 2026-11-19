import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Pty } from "@opencode/core/pty"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { ShellSelect } from "@opencode/core/shell/select"
import { Tool } from "@opencode/core/tool"
import { PtyTool } from "@opencode/core/tool/plugin/pty"
import { ToolOutput } from "@opencode/core/tool-output"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity, toolNodeReplacements } from "./lib/tool"

const sessionA = Session.ID.make("ses_pty_tool_a")
const sessionB = Session.ID.make("ses_pty_tool_b")
const assertions: Permission.AssertInput[] = []
let denyShell = false

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        denyShell && input.action === "shell"
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const ptyCall = (input: typeof PtyTool.Input.Type, sessionID = sessionA, id = "call-pty") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "pty", input },
})

const nodes = LayerNode.group([
  Bus.node,
  Environment.node,
  FileAccess.node,
  Location.node,
  Permission.node,
  PersistentPty.node,
  PluginHooks.node,
  Pty.node,
  ShellSelect.node,
  Tool.node,
  ToolOutput.node,
])

const daemonIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...toolNodeReplacements(permission),
    Global.node.replace(tempGlobalLayer),
    Location.node.replace(tempLocationLayer),
  ]),
)

const unavailablePersistentPtyLayer = Layer.mock(PersistentPty.Service, {
  create: () => Effect.fail(new PersistentPty.UnavailableError({ message: "disabled" })),
  remove: () => Effect.void,
  handoffPrepared: () => false,
})

const fallbackIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...toolNodeReplacements(permission),
    Global.node.replace(tempGlobalLayer),
    Location.node.replace(tempLocationLayer),
    PersistentPty.node.replace(unavailablePersistentPtyLayer),
  ]),
)

const ptyDaemonTest = process.platform === "win32" ? daemonIt.live.skip : daemonIt.live
const ptyFallbackTest = process.platform === "win32" ? fallbackIt.live.skip : fallbackIt.live

const interactiveFlow = Effect.gen(function* () {
  assertions.length = 0
  denyShell = false
  yield* registerToolPlugin(PtyTool.Plugin)
  const registry = yield* Tool.Service

  const script = [
    "import os, sys",
    "assert os.isatty(0), 'stdin not tty'",
    "sys.stdout.write('LINE_PROMPT> ')",
    "sys.stdout.flush()",
    "line = sys.stdin.readline()",
    "sys.stdout.write('GOT:' + line.strip() + chr(10) + 'EOF_PROMPT> ')",
    "sys.stdout.flush()",
    "rest = sys.stdin.read()",
    "sys.stdout.write(f'EOF_DONE:{len(rest)}:RECEIPT-42' + chr(10))",
    "sys.stdout.flush()",
  ].join("; ")

  const opened = yield* executeTool(
    registry,
    ptyCall({
      action: "open",
      command: `python3 -u -c "${script}"`,
      waitFor: "LINE_PROMPT>",
      timeout: 5_000,
    }),
  )
  expect(opened.status).toBe("completed")
  const openOut = opened.output as {
    ptyID: Pty.ID
    status: string
    output: string
    matched?: boolean
    timedOut: boolean
  }
  expect(openOut.status).toBe("running")
  expect(openOut.matched).toBe(true)
  expect(openOut.timedOut).toBe(false)
  expect(openOut.output).toContain("LINE_PROMPT>")
  expect(assertions.some((item) => item.action === "shell")).toBe(true)

  const afterLine = yield* executeTool(
    registry,
    ptyCall({
      action: "write",
      ptyID: openOut.ptyID,
      input: "ALPHA-TOKEN\n",
      waitFor: "EOF_PROMPT>",
      timeout: 5_000,
    }),
  )
  expect(afterLine.status).toBe("completed")
  const lineOut = afterLine.output as { status: string; output: string; matched?: boolean }
  expect(lineOut.status).toBe("running")
  expect(lineOut.matched).toBe(true)
  expect(lineOut.output).toContain("GOT:ALPHA-TOKEN")
  expect(lineOut.output).toContain("EOF_PROMPT>")

  const afterEof = yield* executeTool(
    registry,
    ptyCall({
      action: "write",
      ptyID: openOut.ptyID,
      eof: true,
      waitFor: "EOF_DONE:0:RECEIPT-42",
      timeout: 5_000,
    }),
  )
  expect(afterEof.status).toBe("completed")
  const eofOut = afterEof.output as { status: string; exitCode: number | null; output: string; matched?: boolean }
  expect(eofOut.matched).toBe(true)
  expect(eofOut.output).toContain("EOF_DONE:0:RECEIPT-42")

  const closed = yield* executeTool(
    registry,
    ptyCall({
      action: "close",
      ptyID: openOut.ptyID,
    }),
  )
  expect(closed.status).toBe("completed")
  expect((closed.output as { status: string }).status).toBe("closed")
})

describe("tool.pty", () => {
  ptyDaemonTest("drives interactive line prompt and canonical EOF via PersistentPty daemon", () => interactiveFlow)

  ptyFallbackTest("falls back to local Pty service when PersistentPty daemon is unavailable", () => interactiveFlow)

  ptyFallbackTest("isolates PTY ownership per session and cleans up on SessionEvent.Deleted", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyShell = false
      yield* registerToolPlugin(PtyTool.Plugin)
      const registry = yield* Tool.Service
      const pty = yield* Pty.Service
      const bus = yield* Bus.Service

      const opened = yield* executeTool(
        registry,
        ptyCall({
          action: "open",
          command: "cat",
          timeout: 300,
        }),
      )
      expect(opened.status).toBe("completed")
      const ptyID = (opened.output as { ptyID: Pty.ID }).ptyID

      const crossSession = yield* executeTool(
        registry,
        ptyCall(
          {
            action: "write",
            ptyID,
            input: "nope\n",
          },
          sessionB,
        ),
      )
      expect(crossSession.status).toBe("error")

      yield* bus.publish(SessionEvent.Deleted, { sessionID: sessionA })
      const afterDelete = yield* Effect.exit(pty.get(ptyID))
      expect(afterDelete._tag).toBe("Failure")
    }),
  )

  ptyFallbackTest("enforces shell permission rules before spawning a PTY", () =>
    Effect.gen(function* () {
      assertions.length = 0
      denyShell = true
      yield* registerToolPlugin(PtyTool.Plugin)
      const registry = yield* Tool.Service

      const blocked = yield* executeTool(
        registry,
        ptyCall({
          action: "open",
          command: "echo forbidden",
        }),
      )
      denyShell = false
      expect(blocked.status).toBe("error")
    }),
  )
})
