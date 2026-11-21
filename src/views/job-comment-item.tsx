import { render } from 'preact';
import { splitViaClaude } from '../utils/via-claude';

// One comment thread (a job comment + its replies) — shared by two
// consumers with the identical visual/interaction shape, just one field
// apart: Home dashboard's cross-job Job Chat feed (#homeJobChatList, see
// renderHomeJobChat() in home.ts) and the Job Manager drawer's own
// per-job comments panel (#jobCommentsList, see renderJobComments() in
// job-comments.ts). Both are static, empty elements from index.html
// exclusively written to by their own render function and nothing else,
// same "safe to hand over directly, no wrapper needed" case as Calendar's
// hourly grid (see calendar-hourgrid.tsx's own comment).
//
// The one difference: Home's feed spans every visible job, so each item
// needs a "which job" bubble (jobName/jobColor/onOpenJob); the drawer is
// already scoped to one job, so it omits all three — the bubble just
// isn't rendered when jobName is undefined, rather than this being two
// near-duplicate components. Genuinely the same UI two different contexts
// happen to need, unlike Calendar/Board's own duplicate mini-widgets
// (home-calendar.tsx/home-board-expanded.tsx), which stayed deliberately
// separate because THEIR duplication was specialized rendering logic, not
// just a reused visual shape.
//
// A reply row's open/closed state (toggleHomeReplyBox()/toggleReplyBox(),
// still in home.ts/job-comments.ts, unchanged) is a classList/style.display
// toggle entirely outside this component's own props, same as Board's
// settings dropdown (see board-column-chrome.tsx's own comment) — Preact
// only ever rewrites a prop whose declared value actually changed, and
// this component never declares style.display for the reply row, so an
// open reply box quietly survives a re-render triggered by an unrelated
// comment arriving elsewhere. Unlike Board's dropdown, there's no
// evidence the original code ever wanted a rebuild to force every reply
// box closed (no "close all" call anywhere outside each context's own
// toggle function, which already closes every OTHER one whenever you
// open a new one) — so this is a plain behavioral improvement, not
// something needing a matching "close on rebuild" fix.

export interface JobChatReply {
  replyKey: string;
  author: string;
  whenLabel: string;
  text: string;
  onDelete: () => void;
}

export interface JobChatItemProps {
  itemKey: string;
  // Omitted (all three) by the Job Manager drawer's own panel, which is
  // already scoped to one job — see this file's own header comment.
  jobName?: string;
  jobColor?: string;
  onOpenJob?: (e: MouseEvent | KeyboardEvent) => void;
  important: boolean;
  author: string;
  whenLabel: string;
  text: string;
  replies: JobChatReply[];
  replyRowId: string;
  replyTextareaId: string;
  onDeleteComment: () => void;
  onToggleReply: (e: MouseEvent) => void;
  onReplyKeyDown: (e: KeyboardEvent) => void;
  onPostReply: () => void;
}

// A comment's author, with the "via Claude" tag for ones posted through the
// Claude connector (see src/utils/via-claude.ts).
function Author({ name }: { name: string }) {
  const who = splitViaClaude(name);
  return (
    <span class="job-comment-author" title={name}>
      {who.name}
      {who.viaClaude ? <span class="via-claude-tag">via Claude</span> : null}
    </span>
  );
}

function onEnterOrSpace(fn: (e: KeyboardEvent) => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } };
}

function ReplyItem(p: JobChatReply) {
  return (
    <div class="job-comment-reply-item">
      <div class="job-comment-meta">
        <Author name={p.author} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span class="job-comment-when">{p.whenLabel}</span>
          <button class="job-comment-delete" data-min-tier="commenter" title="Delete reply" onClick={p.onDelete}>×</button>
        </span>
      </div>
      <div class="job-comment-text">{p.text}</div>
    </div>
  );
}

function JobChatItem(p: JobChatItemProps) {
  return (
    <div class="job-comment-item">
      <div class="job-comment-meta">
        <span style={{ display: 'flex', alignItems: 'center' }}>
          {p.jobName ? (
            <span class="job-chat-source" tabIndex={0} role="button" title={'Open ' + p.jobName} onClick={p.onOpenJob} onKeyDown={onEnterOrSpace(p.onOpenJob!)}>
              <span class="job-chat-source-dot" style={{ background: p.jobColor }} />
              {p.jobName}
            </span>
          ) : null}
          {p.important ? <span class="job-comment-important-badge" title="Marked important">●</span> : null}
          <Author name={p.author} />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span class="job-comment-when">{p.whenLabel}</span>
          <button class="job-comment-delete" data-min-tier="commenter" title="Delete comment" onClick={p.onDeleteComment}>×</button>
        </span>
      </div>
      <div class="job-comment-text">{p.text}</div>
      {p.replies.length ? (
        <div class="job-comment-replies">
          {p.replies.map((r) => <ReplyItem key={r.replyKey} {...r} />)}
        </div>
      ) : null}
      <button class="job-comment-reply-btn" onClick={p.onToggleReply}>Reply{p.replies.length ? ' (' + p.replies.length + ')' : ''}</button>
      <div class="job-comment-reply-input-row" id={p.replyRowId}>
        <textarea id={p.replyTextareaId} data-min-tier="commenter" placeholder="Write a reply..." onKeyDown={p.onReplyKeyDown} />
        <button class="btn btn-primary" data-min-tier="commenter" style={{ alignSelf: 'flex-end', padding: '4px 10px', fontSize: '12px' }} onClick={p.onPostReply}>Post Reply</button>
      </div>
    </div>
  );
}

// olderCount/onShowOlder: the feed can be capped to the newest N (see
// Home's HOME_JOB_CHAT_PAGE); older messages load on request.
function JobChatList({ items, olderCount, onShowOlder }: { items: JobChatItemProps[]; olderCount?: number; onShowOlder?: () => void }) {
  if (!items.length) return <div class="job-comments-empty">No comments yet.</div>;
  return (
    <>
      {items.map((it) => <JobChatItem key={it.itemKey} {...it} />)}
      {olderCount && onShowOlder ? (
        <button class="btn job-chat-show-older" onClick={onShowOlder}>Show older messages ({olderCount})</button>
      ) : null}
    </>
  );
}

export function renderJobCommentFeedInto(container: HTMLElement, items: JobChatItemProps[], olderCount?: number, onShowOlder?: () => void): void {
  render(<JobChatList items={items} olderCount={olderCount} onShowOlder={onShowOlder} />, container);
}
