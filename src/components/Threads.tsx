import { Bot, Check, ChevronDown, ChevronRight, GitCommitHorizontal, MessageSquareReply, Sparkles } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";
import { useState } from "react";

import { type Config, contextPrompt, threadPrompt } from "../lib/config";
import { numberHunk } from "../lib/diff";
import { age } from "../lib/format";
import { commitSuggestion, replyToThread, resolveThread } from "../lib/github";
import type { Comment, PullDetail, PullRequest, Thread } from "../lib/model";
import { CodeText, useDiffTokens } from "./Code";
import { Html } from "./Html";
import { useAction } from "./useAction";

// The commented line is the hunk's last line; a few lines above it are usually enough to read it.
const HUNK_CONTEXT_LINES = 4;
// Long conversations show the opening comment and the latest replies; the middle folds away.
const VISIBLE_REPLIES = 2;
const PEEK_LENGTH = 140;
const AVATAR_SIZE = 48;
const MAX_REPLY = 65_000;
// ponytail: forks are left out even when maintainers may edit them; the agent covers that case.
export const PUSH_ROLES = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function threadId(id: string): string {
  return `thread-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Plain text of GitHub's rendered HTML, for agent prompts. */
export function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** Started by a bot (CodeRabbit, Copilot, linters): shown apart so humans come first. */
export function isBotThread(thread: Thread): boolean {
  return thread.comments[0]?.isBot === true;
}

/** A thread is waiting on me when a human other than me spoke last in a thread I own (my PR, or one I started). */
export function waitsOnMe(thread: Thread, me: string, prIsMine: boolean): boolean {
  const last = thread.comments.at(-1);
  if (thread.isResolved || last === undefined || last.author === me || last.isBot) return false;
  return prIsMine || thread.comments[0]?.author === me;
}

function Avatar({ comment }: { comment: Comment }): ReactElement {
  if (comment.avatarUrl === "") {
    return (
      <span className="avatar" aria-hidden>
        {comment.author.slice(0, 2)}
      </span>
    );
  }
  const sep = comment.avatarUrl.includes("?") ? "&" : "?";
  return <img className="avatar" src={`${comment.avatarUrl}${sep}s=${AVATAR_SIZE}`} alt="" loading="lazy" />;
}

export function CommentView({
  comment,
  note,
  prAuthor,
  me,
}: {
  comment: Comment;
  note?: string;
  /** Marks the PR author's comments, like Reddit's OP badge. */
  prAuthor?: string | null;
  me?: string;
}): ReactElement {
  return (
    <div className="comment">
      <div className="comment-head">
        <Avatar comment={comment} />
        <b>{comment.author}</b>
        {comment.author === me ? (
          <span className="badge badge-me">você</span>
        ) : (
          comment.author === prAuthor && <span className="badge">autor da PR</span>
        )}
        {comment.isBot && <span className="badge">bot</span>}
        {note !== undefined && <span className="comment-note">{note}</span>}
        <span className="comment-age">{age(comment.createdAt)}</span>
      </div>
      <div className="comment-body">
        <Html html={comment.bodyHTML} />
      </div>
    </div>
  );
}

/** Renders numbered diff lines; `hunk` may hold several `@@` sections (one file of a full diff). */
export function DiffLines({ hunk, tail, path }: { hunk: string; tail?: number; path?: string }): ReactElement | null {
  const numbered = numberHunk(hunk).filter((l): boolean => l.kind !== "meta");
  const lines = tail === undefined ? numbered : numbered.slice(-tail);
  const tokens = useDiffTokens(lines, path);
  if (hunk.trim() === "") return null;
  return (
    <pre className="hunk">
      {lines.map(
        (l, i): ReactElement => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and may repeat
          <span key={i} className={`hunk-line hunk-${l.kind}`}>
            <span className="hunk-no">{l.oldNo ?? ""}</span>
            <span className="hunk-no">{l.newNo ?? ""}</span>
            <span className="hunk-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
            <CodeText text={l.text} tokens={tokens?.[i]} />
          </span>
        ),
      )}
    </pre>
  );
}

/** Asks the headless agent for a reply to this thread; null when no headless agent is configured. */
export type ReplyDrafter = ((thread: Thread) => Promise<string>) | null;

function ReplyBox({
  config,
  thread,
  draftReply,
  onDone,
  onCancel,
}: {
  config: Config;
  thread: Thread;
  draftReply: ReplyDrafter;
  onDone: () => void;
  onCancel: () => void;
}): ReactElement {
  const [body, setBody] = useState("");
  const action = useAction();
  const text = body.trim();

  const draft = async (): Promise<void> => {
    if (draftReply === null) return;
    await action.run("draft", async (): Promise<void> => setBody(await draftReply(thread)));
  };

  const send = async (alsoResolve: boolean): Promise<void> => {
    const ok = await action.run(alsoResolve ? "send-resolve" : "send", async (): Promise<void> => {
      await replyToThread(config, thread.id, text);
      if (alsoResolve) await resolveThread(config, thread.id);
    });
    if (ok) onDone();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text !== "") void send(false);
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="reply">
      <textarea
        className="input"
        rows={4}
        maxLength={MAX_REPLY}
        placeholder="Responder… (markdown, ⌘↵ envia)"
        value={body}
        // biome-ignore lint/a11y/noAutofocus: the box opens on an explicit "Responder" click
        autoFocus
        onChange={(e): void => setBody(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="reply-actions">
        <button
          type="button"
          className="button primary small"
          disabled={text === "" || action.pending !== null}
          onClick={(): void => void send(false)}
        >
          {action.pending === "send" ? "Enviando…" : "Enviar"}
        </button>
        <button
          type="button"
          className="button small"
          disabled={text === "" || action.pending !== null}
          onClick={(): void => void send(true)}
        >
          {action.pending === "send-resolve" ? "Enviando…" : "Enviar e resolver"}
        </button>
        {draftReply !== null && (
          <button
            type="button"
            className="chip-button accent"
            disabled={action.pending !== null}
            title="O agente lê a thread e o código e escreve uma resposta para você revisar"
            onClick={(): void => void draft()}
          >
            <Sparkles size={14} strokeWidth={2} aria-hidden />
            {action.pending === "draft" ? "Escrevendo…" : "Rascunhar com IA"}
          </button>
        )}
        <button type="button" className="text-button" onClick={onCancel}>
          Cancelar
        </button>
        {action.error !== null && (
          <span className="action-error" role="alert">
            {action.error}
          </span>
        )}
      </div>
    </div>
  );
}

function peek(comment: Comment): string {
  const text = htmlToText(comment.bodyHTML).replace(/\s+/g, " ").trim();
  return text.length > PEEK_LENGTH ? `${text.slice(0, PEEK_LENGTH - 1)}…` : text;
}

/**
 * A review thread laid out like a Reddit conversation: the code it is about, the opening comment, and the replies
 * hanging off a thread line that folds them away. Resolved and bot threads start folded to a one-line peek.
 */
function ThreadCard({
  pr,
  me,
  config,
  thread,
  waiting,
  canPush,
  agentBlocked,
  draftReply,
  onResolve,
  onAgent,
  onChanged,
}: {
  pr: PullRequest;
  me: string;
  config: Config;
  thread: Thread;
  waiting: boolean;
  /** The viewer can push to the PR branch, so a suggestion can be committed from here. */
  canPush: boolean;
  agentBlocked: boolean;
  draftReply: ReplyDrafter;
  onResolve: () => void;
  onAgent: (prompt: string, context?: string) => void;
  onChanged: () => void;
}): ReactElement {
  const [open, setOpen] = useState(waiting || !(thread.isResolved || isBotThread(thread)));
  const [repliesOpen, setRepliesOpen] = useState(true);
  const [allReplies, setAllReplies] = useState(false);
  const [fullCode, setFullCode] = useState(false);
  const [replying, setReplying] = useState(false);
  const action = useAction();
  const [root, ...replies] = thread.comments;
  const last = thread.comments.at(-1);
  const hidden = allReplies ? 0 : Math.max(0, replies.length - VISIBLE_REPLIES);
  const shown = replies.slice(hidden);
  const codeLines = numberHunk(thread.diffHunk).filter((l): boolean => l.kind !== "meta").length;

  const apply = async (): Promise<void> => {
    if (await action.run("apply", async (): Promise<void> => await commitSuggestion(config, pr, thread))) onChanged();
  };

  const fixWithAgent = (): void => {
    const comments = thread.comments.map((c) => ({ author: c.author, text: htmlToText(c.bodyHTML) }));
    onAgent(threadPrompt(pr, thread.path, thread.line, comments));
  };

  const classes = [
    "thread",
    thread.isResolved ? "is-resolved" : "",
    waiting ? "is-waiting" : "",
    open ? "" : "is-folded",
  ];
  return (
    <article id={threadId(thread.id)} className={classes.filter(Boolean).join(" ")}>
      <header className="thread-head">
        <button type="button" className="thread-toggle" aria-expanded={open} onClick={(): void => setOpen(!open)}>
          {open ? (
            <ChevronDown size={15} strokeWidth={2} aria-hidden />
          ) : (
            <ChevronRight size={15} strokeWidth={2} aria-hidden />
          )}
          <span className="thread-path">
            {thread.path}
            {thread.line !== null && <b>:{thread.line}</b>}
          </span>
        </button>
        {waiting && <span className="thread-waiting">Esperando você</span>}
        {thread.isResolved && <span className="thread-tag">resolvida</span>}
        {thread.isOutdated && <span className="thread-tag">desatualizada</span>}
        {isBotThread(thread) && <span className="thread-tag">bot</span>}
        <span className="thread-count">
          {thread.comments.length} {thread.comments.length === 1 ? "comentário" : "comentários"}
          {last !== undefined && ` · ${age(last.createdAt)}`}
        </span>
      </header>

      {!open && last !== undefined && (
        <button type="button" className="thread-peek" onClick={(): void => setOpen(true)}>
          <b>{last.author}:</b> {peek(last)}
        </button>
      )}

      {open && (
        <>
          <div className="thread-code">
            <DiffLines hunk={thread.diffHunk} path={thread.path} {...(fullCode ? {} : { tail: HUNK_CONTEXT_LINES })} />
            {codeLines > HUNK_CONTEXT_LINES && (
              <button type="button" className="more-code" onClick={(): void => setFullCode(!fullCode)}>
                {fullCode ? "Mostrar menos código" : `Mostrar mais código (${codeLines} linhas)`}
              </button>
            )}
          </div>

          <div className="convo">
            {root !== undefined && <CommentView comment={root} prAuthor={pr.author} me={me} />}
            {replies.length > 0 && (
              <div className={repliesOpen ? "replies" : "replies is-folded"}>
                <button
                  type="button"
                  className="threadline"
                  aria-label={repliesOpen ? "Recolher respostas" : "Mostrar respostas"}
                  aria-expanded={repliesOpen}
                  onClick={(): void => setRepliesOpen(!repliesOpen)}
                />
                {repliesOpen ? (
                  <>
                    {hidden > 0 && (
                      <button type="button" className="more-replies" onClick={(): void => setAllReplies(true)}>
                        Ver {hidden} {hidden === 1 ? "resposta anterior" : "respostas anteriores"}
                      </button>
                    )}
                    {shown.map(
                      (c): ReactElement => (
                        <CommentView key={c.id} comment={c} prAuthor={pr.author} me={me} />
                      ),
                    )}
                  </>
                ) : (
                  <button type="button" className="more-replies" onClick={(): void => setRepliesOpen(true)}>
                    {replies.length} {replies.length === 1 ? "resposta escondida" : "respostas escondidas"}
                  </button>
                )}
              </div>
            )}
          </div>

          {!thread.isResolved &&
            (replying ? (
              <ReplyBox
                config={config}
                thread={thread}
                draftReply={draftReply}
                onCancel={(): void => setReplying(false)}
                onDone={(): void => {
                  setReplying(false);
                  onChanged();
                }}
              />
            ) : (
              <div className="thread-actions">
                {canPush && thread.suggestion !== null && thread.range !== undefined && (
                  <button
                    type="button"
                    className="link-button good"
                    disabled={action.pending !== null}
                    title="Faz um commit com a sugestão na branch da PR e resolve a conversa"
                    onClick={(): void => void apply()}
                  >
                    <GitCommitHorizontal size={14} strokeWidth={2} aria-hidden />
                    {action.pending === "apply" ? "Aplicando…" : "Aplicar sugestão"}
                  </button>
                )}
                <button type="button" className="link-button" onClick={(): void => setReplying(true)}>
                  <MessageSquareReply size={14} strokeWidth={2} aria-hidden /> Responder
                </button>
                <button type="button" className="link-button" disabled={action.pending !== null} onClick={onResolve}>
                  <Check size={14} strokeWidth={2} aria-hidden />
                  Resolver
                </button>
                <button
                  type="button"
                  className="link-button accent"
                  disabled={agentBlocked}
                  title={agentBlocked ? "Já há um agente aberto nesta PR. Encerre-o para iniciar outro." : undefined}
                  onClick={fixWithAgent}
                >
                  <Bot size={14} strokeWidth={2} aria-hidden /> Corrigir com agente
                </button>
                {action.error !== null && (
                  <span className="action-error" role="alert">
                    {action.error}
                  </span>
                )}
              </div>
            ))}
        </>
      )}
    </article>
  );
}

function ThreadIndex({ threads, waiting }: { threads: Thread[]; waiting: Set<string> }): ReactElement {
  return (
    <nav className="tindex" aria-label="Índice das conversas">
      {threads.map((t): ReactElement => {
        const last = t.comments.at(-1);
        return (
          <button
            key={t.id}
            type="button"
            className={waiting.has(t.id) ? "tindex-item is-waiting" : "tindex-item"}
            onClick={(): void =>
              document.getElementById(threadId(t.id))?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            <span className="tindex-dot" aria-hidden />
            <span className="tindex-body">
              <span className="tindex-file">
                {fileName(t.path)}
                {t.line !== null && `:${t.line}`}
              </span>
              <span className="tindex-last">
                {last === undefined ? "" : `${last.author} · ${age(last.createdAt)}`}
                {waiting.has(t.id) && " · espera você"}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function ThreadsTab({
  pr,
  config,
  detail,
  me,
  agentBlocked,
  draftReply,
  resolveError,
  onResolve,
  onAgent,
  onChanged,
}: {
  pr: PullRequest;
  config: Config;
  detail: PullDetail;
  me: string;
  agentBlocked: boolean;
  draftReply: ReplyDrafter;
  /** The last resolve that GitHub refused; its thread is back in the list. */
  resolveError: string | null;
  onResolve: (thread: Thread) => void;
  onAgent: (prompt: string, context?: string) => void;
  onChanged: () => void;
}): ReactElement {
  const prIsMine = pr.author === me;
  const canPush = !pr.isCrossRepository && pr.closed === undefined && PUSH_ROLES.has(detail.permission);
  const waiting = new Set(detail.threads.filter((t): boolean => waitsOnMe(t, me, prIsMine)).map((t): string => t.id));
  // Human threads waiting on me first, then the other open ones; bot threads and resolved ones fold away.
  const open = detail.threads
    .filter((t): boolean => !t.isResolved && !isBotThread(t))
    .sort((a, b): number => Number(waiting.has(b.id)) - Number(waiting.has(a.id)));
  const bots = detail.threads.filter((t): boolean => !t.isResolved && isBotThread(t));
  const resolved = detail.threads.filter((t): boolean => t.isResolved);

  const fixBots = (): void => {
    const context = bots.flatMap((t): string[] => [
      `## ${t.path}${t.line === null ? "" : `:${t.line}`}`,
      ...t.comments.map((c): string => `**${c.author}:** ${htmlToText(c.bodyHTML)}`),
      "",
    ]);
    onAgent(
      contextPrompt(
        `Automated reviewers left ${bots.length} open comment(s) on pull request ${pr.url}. Fix the ones that are real problems in this worktree and explain why you skipped the others.`,
      ),
      context.join("\n"),
    );
  };

  if (open.length === 0 && resolved.length === 0 && bots.length === 0)
    return <p className="notice">Ninguém comentou no código ainda.</p>;
  const card = (t: Thread): ReactElement => (
    <ThreadCard
      key={t.id}
      pr={pr}
      me={me}
      config={config}
      thread={t}
      waiting={waiting.has(t.id)}
      canPush={canPush}
      agentBlocked={agentBlocked}
      draftReply={draftReply}
      onResolve={(): void => onResolve(t)}
      onAgent={onAgent}
      onChanged={onChanged}
    />
  );
  return (
    <div className={open.length > 1 ? "threads-layout with-index" : "threads-layout"}>
      {open.length > 1 && <ThreadIndex threads={open} waiting={waiting} />}
      <div className="tlist">
        {resolveError !== null && (
          <p className="action-error" role="alert">
            {resolveError}
          </p>
        )}
        {open.length === 0 && <p className="notice">Nenhuma conversa de pessoas em aberto.</p>}
        {open.map(card)}
        {bots.length > 0 && (
          <details className="fold">
            <summary>
              Comentários de bots <b>{bots.length}</b>
            </summary>
            {prIsMine && (
              <div className="fold-actions">
                <button type="button" className="chip-button accent" disabled={agentBlocked} onClick={fixBots}>
                  <Bot size={14} strokeWidth={2} aria-hidden /> Corrigir as que fazem sentido com agente
                </button>
              </div>
            )}
            {bots.map(card)}
          </details>
        )}
        {resolved.length > 0 && (
          <details className="fold">
            <summary>
              Resolvidas <b>{resolved.length}</b>
            </summary>
            {resolved.map(card)}
          </details>
        )}
      </div>
    </div>
  );
}
