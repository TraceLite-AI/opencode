export * as PtyTool from "./pty.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Fiber, Schema } from "effect"
import { Bus } from "../../bus.js"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { PersistentPty } from "../../persistent-pty.js"
import { Pty } from "../../pty.js"
import { NonNegativeInt } from "../../schema.js"
import { SessionEvent } from "../../session/event.js"
import type { SessionSchema } from "../../session/schema.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellTool } from "./shell.js"
import { toolFailure } from "../runtime.js"

export const name = "pty"

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 2 * 60 * 1_000
const IDLE_SETTLE_MS = 150

const DESCRIPTION = [
  "Drive an interactive pseudoterminal (PTY) session across multiple turns or calls.",
  "Use `open` to launch an interactive REPL, debugger, CLI wizard, or prompt-driven program in a retained PTY and receive its `ptyID`.",
  "Use `write` to send verbatim input (include `\n` to submit a line), `interrupt: true` (`Ctrl+C`), or `eof: true` (`Ctrl+D` end-of-file when the line buffer is empty) and collect the resulting output.",
  "Use `read` to read or wait for further output from an active `ptyID`, and `close` to terminate and release a session when finished.",
  "Prefer the `shell` tool for ordinary non-interactive commands.",
].join(" ")

export const Input = Schema.Struct({
  action: Schema.Literals(["open", "write", "read", "close"]).annotate({
    description: 'Operation to perform: "open", "write", "read", or "close".',
  }),
  ptyID: Schema.optionalKey(Pty.ID).annotate({
    description: 'Retained PTY session ID returned by `open`. Required for "write", "read", and "close".',
  }),
  command: Schema.optionalKey(Schema.String).annotate({
    description: 'Shell command to launch inside the new PTY for `open`. Omit to start an interactive login shell.',
  }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory for `open`. Defaults to the current working directory.",
  }),
  input: Schema.optionalKey(Schema.String).annotate({
    description: "Exact characters to write to the PTY for `write`. Include `\n` when submitting a line.",
  }),
  eof: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Send canonical TTY end-of-file (`Ctrl+D` / `\x04`) during `write`.",
  }),
  interrupt: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Send `Ctrl+C` (`\x03`) during `write`.",
  }),
  waitFor: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional literal substring or `/pattern/flags` regular expression to wait for in newly read PTY output before returning.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Maximum milliseconds to wait for output or \`waitFor\` (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
  cursor: Schema.optionalKey(NonNegativeInt).annotate({
    description: "Optional output cursor to read from. Defaults to unread output since the previous call on this `ptyID`.",
  }),
})

const StructuredOutput = Schema.Struct({
  ptyID: Pty.ID,
  status: Schema.Literals(["running", "exited", "closed"]),
  exitCode: Schema.NullOr(Schema.Number),
  output: Schema.String,
  cursor: NonNegativeInt,
  timedOut: Schema.Boolean,
  matched: Schema.optionalKey(Schema.Boolean),
})

type OwnedSession = {
  readonly sessionID: SessionSchema.ID
  readonly backend: "persistent" | "local"
  cursor: number
  exited?: { readonly exitCode: number | null }
}

type Collected = {
  readonly status: "running" | "exited"
  readonly exitCode: number | null
  readonly output: string
  readonly cursor: number
  readonly timedOut: boolean
  readonly matched?: boolean
}

function compileMatcher(pattern: string | undefined): ((text: string) => boolean) | undefined {
  if (!pattern) return undefined
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const slash = pattern.lastIndexOf("/")
    const source = pattern.slice(1, slash)
    const flags = pattern.slice(slash + 1)
    try {
      const regex = new RegExp(source, flags)
      return (text) => regex.test(text)
    } catch {
      return (text) => text.includes(pattern)
    }
  }
  return (text) => text.includes(pattern)
}

function normalizeOutput(raw: string) {
  return raw.replace(/\r\n/g, "\n")
}

function formatContent(ptyID: Pty.ID, status: "running" | "exited" | "closed", result: Collected) {
  const cleaned = normalizeOutput(result.output)
  const details = [
    `ptyID: ${ptyID}`,
    `status: ${status}`,
    ...(result.exitCode === null ? [] : [`exitCode: ${result.exitCode}`]),
    `cursor: ${result.cursor}`,
    ...(result.timedOut ? ["timedOut: true"] : []),
  ].join(", ")
  const footer = `[${details}]`
  if (!cleaned) return footer
  return `${cleaned}${cleaned.endsWith("\n") ? "" : "\n"}\n${footer}`
}

function clampTimeout(value: number | undefined) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (value <= 0) return 0
  return Math.min(value, MAX_TIMEOUT_MS)
}

function childEnvironment(sessionID: SessionSchema.ID): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of Object.entries(process.env)) {
    if (entry[1] !== undefined) result[entry[0]] = entry[1]
  }
  result.TERM = "xterm-256color"
  result.OPENCODE_TERMINAL = "1"
  result.OPENCODE_SESSION_ID = sessionID
  return result
}

const collectPersistent = Effect.fn("PtyTool.collectPersistent")(function* (
  persistent: PersistentPty.Interface,
  id: Pty.ID,
  tracked: OwnedSession,
  fromCursor: number,
  options: {
    readonly payload?: string
    readonly waitFor?: string
    readonly timeout: number
    readonly cancel?: Effect.Effect<void>
  },
) {
  const matcher = compileMatcher(options.waitFor)
  if (tracked.exited) {
    if (options.payload) {
      return yield* new ToolFailure({ message: `PTY session ${id} has already exited and cannot accept input.` })
    }
    return {
      status: "exited" as const,
      exitCode: tracked.exited.exitCode,
      output: "",
      cursor: tracked.cursor,
      timedOut: false,
      ...(matcher ? { matched: false } : {}),
    } satisfies Collected
  }

  const settled = Promise.withResolvers<"matched" | "exited" | "idle" | "timeout">()
  const chunks: Uint8Array[] = []
  let endCursor = fromCursor
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const clearIdle = () => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const finish = (reason: "matched" | "exited" | "idle" | "timeout") => {
    clearIdle()
    settled.resolve(reason)
  }
  const currentText = () => normalizeOutput(Buffer.concat(chunks).toString("utf8"))

  const attached = yield* persistent
    .attach(id, {
      cursor: fromCursor,
      attachmentID: crypto.randomUUID(),
      role: "observer",
      onEvent: (event) => {
        if (event.type === "output") {
          chunks.push(event.data)
          endCursor = Math.max(endCursor, event.end)
          if (matcher) {
            if (matcher(currentText())) finish("matched")
            return
          }
          clearIdle()
          idleTimer = setTimeout(() => finish("idle"), IDLE_SETTLE_MS)
          return
        }
        if (event.type === "exited") {
          endCursor = Math.max(endCursor, event.finalOffset)
          tracked.exited = { exitCode: event.exitCode ?? null }
          finish("exited")
        }
      },
      onEnd: () => finish("exited"),
    })
    .pipe(
      Effect.catchTag("PersistentPty.NotFoundError", () => Effect.succeed(undefined)),
    )

  if (!attached) {
    tracked.exited ??= { exitCode: null }
    if (options.payload) {
      return yield* new ToolFailure({ message: `PTY session ${id} has already exited and cannot accept input.` })
    }
    return {
      status: "exited" as const,
      exitCode: tracked.exited.exitCode,
      output: "",
      cursor: tracked.cursor,
      timedOut: false,
      ...(matcher ? { matched: false } : {}),
    } satisfies Collected
  }

  return yield* Effect.gen(function* () {
    if (attached.replay.data.byteLength > 0) chunks.push(attached.replay.data)
    endCursor = Math.max(endCursor, attached.replay.endOffset)
    attached.activate()
    if (options.payload) yield* persistent.write(id, options.payload)
    if (matcher && chunks.length > 0 && matcher(currentText())) finish("matched")
    if (!matcher && chunks.length > 0 && !options.payload) {
      clearIdle()
      idleTimer = setTimeout(() => finish("idle"), IDLE_SETTLE_MS)
    }
    if (options.timeout === 0) finish("idle")

    const timer = setTimeout(() => finish("timeout"), options.timeout)
    const cancelFiber = options.cancel
      ? yield* options.cancel.pipe(
          Effect.andThen(Effect.sync(() => finish("timeout"))),
          Effect.interruptible,
          Effect.forkChild({ startImmediately: true }),
        )
      : undefined

    const reason = yield* Effect.promise(() => settled.promise).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          clearTimeout(timer)
          clearIdle()
          attached.detach()
        }),
      ),
    )
    if (cancelFiber) yield* Fiber.interrupt(cancelFiber)

    const decoded = Buffer.concat(chunks).toString("utf8")
    const matched = matcher ? reason === "matched" || matcher(normalizeOutput(decoded)) : undefined
    const status = tracked.exited ? ("exited" as const) : ("running" as const)
    const timedOut = reason === "timeout" && Boolean(matcher && !matched && status === "running")
    return {
      status,
      exitCode: tracked.exited?.exitCode ?? null,
      output: decoded,
      cursor: endCursor,
      timedOut,
      ...(matched === undefined ? {} : { matched }),
    } satisfies Collected
  })
})

const collectLocal = Effect.fn("PtyTool.collectLocal")(function* (
  pty: Pty.Interface,
  id: Pty.ID,
  fromCursor: number,
  options: {
    readonly payload?: string
    readonly waitFor?: string
    readonly timeout: number
    readonly cancel?: Effect.Effect<void>
  },
) {
  const matcher = compileMatcher(options.waitFor)
  if (!options.payload) {
    const initial = yield* pty.read(id, fromCursor)
    const normalized = normalizeOutput(initial.output)
    if (matcher && matcher(normalized)) {
      return {
        status: initial.info.status,
        exitCode: initial.info.exitCode ?? null,
        output: initial.output,
        cursor: initial.cursor,
        timedOut: false,
        matched: true,
      } satisfies Collected
    }
    if (initial.info.status === "exited" || options.timeout === 0) {
      return {
        status: initial.info.status,
        exitCode: initial.info.exitCode ?? null,
        output: initial.output,
        cursor: initial.cursor,
        timedOut: false,
        ...(matcher ? { matched: false } : {}),
      } satisfies Collected
    }
  }

  const settled = Promise.withResolvers<"matched" | "exited" | "idle" | "timeout">()
  let combined = ""
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const clearIdle = () => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const finish = (reason: "matched" | "exited" | "idle" | "timeout") => {
    clearIdle()
    settled.resolve(reason)
  }
  const onChunk = (chunk: string) => {
    combined += chunk
    if (matcher) {
      if (matcher(normalizeOutput(combined))) finish("matched")
      return
    }
    clearIdle()
    idleTimer = setTimeout(() => finish("idle"), IDLE_SETTLE_MS)
  }

  const attached = yield* pty
    .attach(id, {
      cursor: fromCursor,
      onData: onChunk,
      onEnd: () => finish("exited"),
    })
    .pipe(
      Effect.catchTag("Pty.ExitedError", () => Effect.succeed(undefined)),
    )

  if (!attached) {
    if (options.payload) {
      return yield* new ToolFailure({ message: `PTY session ${id} has already exited and cannot accept input.` })
    }
    const snapshot = yield* pty.read(id, fromCursor)
    const matched = matcher ? matcher(normalizeOutput(snapshot.output)) : undefined
    return {
      status: snapshot.info.status,
      exitCode: snapshot.info.exitCode ?? null,
      output: snapshot.output,
      cursor: snapshot.cursor,
      timedOut: false,
      ...(matched === undefined ? {} : { matched }),
    } satisfies Collected
  }

  return yield* Effect.gen(function* () {
    combined = attached.replay
    if (options.payload) attached.write(options.payload)
    attached.activate()
    if (matcher && combined && matcher(normalizeOutput(combined))) finish("matched")
    if (!matcher && combined && !options.payload) {
      clearIdle()
      idleTimer = setTimeout(() => finish("idle"), IDLE_SETTLE_MS)
    }
    if (options.timeout === 0) finish("idle")

    const timer = setTimeout(() => finish("timeout"), options.timeout)
    const cancelFiber = options.cancel
      ? yield* options.cancel.pipe(
          Effect.andThen(Effect.sync(() => finish("timeout"))),
          Effect.interruptible,
          Effect.forkChild({ startImmediately: true }),
        )
      : undefined

    const reason = yield* Effect.promise(() => settled.promise).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          clearTimeout(timer)
          clearIdle()
          attached.detach()
        }),
      ),
    )
    if (cancelFiber) yield* Fiber.interrupt(cancelFiber)

    const finalRead = yield* pty.read(id, fromCursor)
    const matched = matcher ? reason === "matched" || matcher(normalizeOutput(finalRead.output)) : undefined
    const timedOut = reason === "timeout" && Boolean(matcher && !matched && finalRead.info.status === "running")
    return {
      status: finalRead.info.status,
      exitCode: finalRead.info.exitCode ?? null,
      output: finalRead.output,
      cursor: finalRead.cursor,
      timedOut,
      ...(matched === undefined ? {} : { matched }),
    } satisfies Collected
  })
})

export const Plugin = {
  id: "opencode.tool.pty",
  effect: Effect.fn("PtyTool.Plugin")(function* (ctx: Context) {
    const persistent = yield* PersistentPty.Service
    const pty = yield* Pty.Service
    const bus = yield* Bus.Service
    const access = yield* FileAccess.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const shellSelect = yield* ShellSelect.Service
    const owned = new Map<Pty.ID, OwnedSession>()

    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== SessionEvent.Deleted.type) return Effect.void
      const deletedID = (event.data as typeof SessionEvent.Deleted.data.Type).sessionID
      const localIDs: Pty.ID[] = []
      const persistentIDs: Pty.ID[] = []
      for (const entry of owned.entries()) {
        if (entry[1].sessionID !== deletedID) continue
        if (entry[1].backend === "persistent") persistentIDs.push(entry[0])
        if (entry[1].backend === "local") localIDs.push(entry[0])
        owned.delete(entry[0])
      }
      return Effect.all(
        [
          Effect.forEach(persistentIDs, (id) => persistent.remove(id).pipe(Effect.ignore), { discard: true }),
          Effect.forEach(localIDs, (id) => pty.remove(id).pipe(Effect.ignore), { discard: true }),
        ],
        { discard: true },
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const requireOwned = (ptyID: Pty.ID | undefined, sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        if (!ptyID) {
          return yield* new ToolFailure({ message: "Missing required `ptyID` for this PTY action." })
        }
        const entry = owned.get(ptyID)
        if (!entry || entry.sessionID !== sessionID) {
          return yield* new ToolFailure({ message: `Unknown or inaccessible PTY session: ${ptyID}` })
        }
        return { ptyID, entry }
      })

    const authorizeOpen = Effect.fn("PtyTool.authorizeOpen")(function* (
      command: string | undefined,
      workdir: string | undefined,
      shellFile: string,
      context: Tool.Context,
    ) {
      const requested = workdir ?? location.directory
      const target = yield* access.resolve({ path: requested, kind: "directory" })
      if (!command || !command.trim()) {
        yield* access.authorizeExternal([target], context)
        yield* permission.assert({
          action: ShellTool.name,
          resources: ["*"],
          save: ["*"],
          ...Permission.invocation(context),
        })
      }
      if (command && command.trim()) {
        const parsed = yield* ShellParse.scan(command, shellFile, target.absolute)
        const directories = yield* Effect.forEach(parsed.directories, (directory) =>
          access.resolve({
            path: FileAccess.resolvePath(target.absolute, directory),
            kind: "directory",
          }),
        )
        yield* access.authorizeExternal([target, ...directories], context)
        const resources = parsed.commands.length > 0 ? parsed.commands.map((item) => item.resource) : [command.trim()]
        const save = parsed.commands.length > 0 ? parsed.commands.map((item) => item.save) : [command.trim()]
        yield* permission.assert({
          action: ShellTool.name,
          resources,
          save,
          ...Permission.invocation(context),
        })
      }
      const kind = yield* Environment.typeFollowing(target.environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (kind !== "directory") {
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      }
      return target.absolute
    })

    const runCollect = Effect.fnUntraced(function* (
      id: Pty.ID,
      entry: OwnedSession,
      fromCursor: number,
      options: {
        readonly payload?: string
        readonly waitFor?: string
        readonly timeout: number
        readonly cancel?: Effect.Effect<void>
      },
    ) {
      if (entry.backend === "persistent") {
        return yield* collectPersistent(persistent, id, entry, fromCursor, options)
      }
      return yield* collectLocal(pty, id, fromCursor, options)
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          description: DESCRIPTION,
          input: Input,
          output: StructuredOutput,
          options: { permission: ShellTool.name, codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              const timeout = clampTimeout(input.timeout)

              if (input.action === "open") {
                const shellFile = yield* shellSelect.resolve({ priority: "compat" })
                const cwd = yield* authorizeOpen(input.command, input.workdir, shellFile, context)
                const args = input.command && input.command.trim() ? ShellSelect.args(shellFile, input.command) : []
                const title = input.command?.trim() ? input.command.trim().slice(0, 80) : "Interactive PTY"
                const env = childEnvironment(context.sessionID)
                const opened = yield* persistent
                  .create(context.sessionID, {
                    command: shellFile,
                    args,
                    cwd,
                    title,
                    env,
                  })
                  .pipe(
                    Effect.map((info) => ({ id: info.id, backend: "persistent" as const })),
                    Effect.catchTag("PersistentPty.UnavailableError", () =>
                      pty
                        .create({
                          command: shellFile,
                          args,
                          cwd,
                          title,
                          env,
                        })
                        .pipe(Effect.map((info) => ({ id: info.id, backend: "local" as const }))),
                    ),
                  )
                const tracked: OwnedSession = {
                  sessionID: context.sessionID,
                  backend: opened.backend,
                  cursor: 0,
                }
                owned.set(opened.id, tracked)
                const result = yield* runCollect(opened.id, tracked, 0, {
                  waitFor: input.waitFor,
                  timeout,
                  cancel: context.cancel,
                })
                tracked.cursor = result.cursor
                const outputValue = {
                  ptyID: opened.id,
                  status: result.status,
                  exitCode: result.exitCode,
                  output: normalizeOutput(result.output),
                  cursor: result.cursor,
                  timedOut: result.timedOut,
                  ...(result.matched === undefined ? {} : { matched: result.matched }),
                }
                return {
                  output: outputValue,
                  content: [{ type: "text" as const, text: formatContent(opened.id, result.status, result) }],
                  metadata: outputValue,
                }
              }

              const found = yield* requireOwned(input.ptyID, context.sessionID)
              const fromCursor = input.cursor ?? found.entry.cursor

              if (input.action === "close") {
                const drained = yield* runCollect(found.ptyID, found.entry, fromCursor, {
                  timeout: 0,
                  cancel: context.cancel,
                }).pipe(Effect.catch(() => Effect.succeed(undefined)))
                owned.delete(found.ptyID)
                if (found.entry.backend === "persistent") {
                  yield* persistent.remove(found.ptyID).pipe(Effect.ignore)
                }
                if (found.entry.backend === "local") {
                  yield* pty.remove(found.ptyID).pipe(Effect.ignore)
                }
                const collected: Collected = {
                  status: "exited",
                  exitCode: drained?.exitCode ?? found.entry.exited?.exitCode ?? null,
                  output: drained?.output ?? "",
                  cursor: drained?.cursor ?? fromCursor,
                  timedOut: false,
                }
                const outputValue = {
                  ptyID: found.ptyID,
                  status: "closed" as const,
                  exitCode: collected.exitCode,
                  output: normalizeOutput(collected.output),
                  cursor: collected.cursor,
                  timedOut: false,
                }
                return {
                  output: outputValue,
                  content: [{ type: "text" as const, text: formatContent(found.ptyID, "closed", collected) }],
                  metadata: outputValue,
                }
              }

              if (input.action === "write") {
                const payload = `${input.input ?? ""}${input.interrupt ? "\x03" : ""}${input.eof ? "\x04" : ""}`
                if (!payload) {
                  return yield* new ToolFailure({
                    message: "PTY `write` requires non-empty `input`, `eof: true`, or `interrupt: true`.",
                  })
                }
                const result = yield* runCollect(found.ptyID, found.entry, fromCursor, {
                  payload,
                  waitFor: input.waitFor,
                  timeout,
                  cancel: context.cancel,
                })
                found.entry.cursor = result.cursor
                const outputValue = {
                  ptyID: found.ptyID,
                  status: result.status,
                  exitCode: result.exitCode,
                  output: normalizeOutput(result.output),
                  cursor: result.cursor,
                  timedOut: result.timedOut,
                  ...(result.matched === undefined ? {} : { matched: result.matched }),
                }
                return {
                  output: outputValue,
                  content: [{ type: "text" as const, text: formatContent(found.ptyID, result.status, result) }],
                  metadata: outputValue,
                }
              }

              const result = yield* runCollect(found.ptyID, found.entry, fromCursor, {
                waitFor: input.waitFor,
                timeout,
                cancel: context.cancel,
              })
              found.entry.cursor = result.cursor
              const outputValue = {
                ptyID: found.ptyID,
                status: result.status,
                exitCode: result.exitCode,
                output: normalizeOutput(result.output),
                cursor: result.cursor,
                timedOut: result.timedOut,
                ...(result.matched === undefined ? {} : { matched: result.matched }),
              }
              return {
                output: outputValue,
                content: [{ type: "text" as const, text: formatContent(found.ptyID, result.status, result) }],
                metadata: outputValue,
              }
            }).pipe(Effect.mapError(toolFailure("PTY operation failed"))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
