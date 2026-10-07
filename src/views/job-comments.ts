// Job Manager: comments/replies on a job. Pure logic + rendering for the
// Job Manager drawer's own comments panel (#jobCommentsPanel) — the
// "post a comment"/"post a reply" functions (postJobComment/postJobReply)
// are also called directly by Home's Job Chat widget (see
// postHomeJobChatComment()/addHomeJobReply() in home.ts), which real-
// imports formatCommentWhen/postJobComment/postJobReply from here.
import type { Job } from '../core/types';
import { findJob } from '../core/models';
import { genId } from '../utils/id';
import { getStoredDisplayName, getStoredUsername, DISPLAY_NAME_KEY } from '../auth/session';
import { logActivity } from '../sync/outbound';
import { renderHomeJobChat } from './home';
import { renderJobCommentFeedInto, type JobChatItemProps, type JobChatReply } from './job-comment-item';

// One shared formatter: toLocaleString() with options builds a new
// formatter on every call, which made this the single most expensive
// step of a Home redraw on a large project. Same output either way.
const COMMENT_WHEN_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export function formatCommentWhen(when: number | undefined): string {
  return when ? COMMENT_WHEN_FORMAT.format(new Date(when)) : 'Imported';
}

export function renderJobComments(job: Job): void {
  // The drawer only ever shows ONE job's comments at a time, in a single
  // shared #jobCommentsList element — without this guard, calling this
  // for a job other than whichever one the drawer currently has open
  // (e.g. deleteJobComment()/addJobReply() reached from the Home Job
  // Chat widget, which acts on jobs regardless of what's open) would
  // silently overwrite that list with the WRONG job's comments while the
  // rest of the drawer (title, fields) kept showing the job that's
  // actually open.
  if (job.id !== editingJobId) return;
  const listEl = document.getElementById('jobCommentsList');
  if (!listEl) return;
  const comments = ((job.comments as any[]) || []).slice().sort(function (a, b) { return (b.when || 0) - (a.when || 0); });

  // Keeps the collapsed tab's badge (see .job-comments-panel.collapsed)
  // in sync — same count convention as the job list's own comment badge.
  const tabCountEl = document.getElementById('jobCommentsTabCount');
  if (tabCountEl) {
    tabCountEl.textContent = String(comments.length);
    tabCountEl.style.display = comments.length ? 'flex' : 'none';
  }
  const importantDotEl = document.getElementById('jobCommentsTabImportantDot');
  if (importantDotEl) {
    (importantDotEl as HTMLElement).style.display = comments.some(function (c) { return c.important; }) ? 'block' : 'none';
  }

  renderJobCommentFeedInto(listEl, comments.map(function (c) { return buildJobCommentItemProps(job, c); }));
  applyPermissionGating(); // rebuilt on every comment/reply edit, outside renderAll()'s own sweep
}

// Same shared shape Home's own Job Chat feed uses (job-comment-item.tsx)
// minus the jobName/jobColor/onOpenJob fields — this panel is already
// scoped to one job, so there's no "which job" bubble to show. See that
// file's own header comment for why this is a genuine reuse rather than
// a second near-duplicate component.
function buildJobCommentItemProps(job: Job, c: any): JobChatItemProps {
  // Oldest-first within a thread so a reply chain reads top-to-bottom.
  const replies = ((c.replies as any[]) || []).slice().sort(function (a, b) { return (a.when || 0) - (b.when || 0); });
  const replyProps: JobChatReply[] = replies.map(function (r) {
    return {
      replyKey: r.id,
      author: r.author || 'Someone',
      whenLabel: formatCommentWhen(r.when),
      text: r.text,
      onDelete: function () { deleteJobReply(job.id, c.id, r.id); },
    };
  });

  return {
    itemKey: c.id,
    important: !!c.important,
    author: c.author || 'Someone',
    whenLabel: formatCommentWhen(c.when),
    text: c.text,
    replies: replyProps,
    replyRowId: 'reply-row-' + c.id,
    replyTextareaId: 'reply-ta-' + c.id,
    onDeleteComment: function () { deleteJobComment(job.id, c.id); },
    onToggleReply: function (e: MouseEvent) { toggleReplyBox(c.id, e); },
    onReplyKeyDown: function (e: KeyboardEvent) { handleReplyKey(e, job.id, c.id); },
    onPostReply: function () { addJobReply(job.id, c.id); },
  };
}

export function toggleReplyBox(commentId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const row = document.getElementById('reply-row-' + commentId);
  if (!row) return;
  const isOpen = row.style.display === 'flex';
  // Only one reply box open at a time keeps the panel from getting cluttered.
  document.querySelectorAll('.job-comment-reply-input-row').forEach(function (r) { (r as HTMLElement).style.display = 'none'; });
  if (!isOpen) {
    row.style.display = 'flex';
    const ta = document.getElementById('reply-ta-' + commentId);
    if (ta) ta.focus();
  }
}

// Shared by the drawer's own reply box and the Home Job Chat widget's
// (see toggleHomeReplyBox()/addHomeJobReply() in home.ts) — the actual
// "post a reply" logic only cares about jobId/commentId/text, not which
// UI surface it came from. Returns the new reply object, or null if
// nothing was posted (empty text, unknown job/comment).
export function postJobReply(jobId: string, commentId: string, text: string | false | undefined): any {
  const found = findJob(jobId);
  if (!found) return null;
  const job = found.job;
  const comment = ((job.comments as any[]) || []).find(function (c) { return c.id === commentId; });
  if (!comment) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  let author = getStoredDisplayName();
  if (!author) {
    author = window.prompt('Your name (shown on comments):') || 'Team member';
    localStorage.setItem(DISPLAY_NAME_KEY, author);
  }

  if (!Array.isArray(comment.replies)) comment.replies = [];
  const reply = { id: genId(), author: author, by: getStoredUsername(), text: trimmed, when: Date.now() };
  comment.replies.push(reply);
  saveJobs();
  logActivity('replied to a comment on job "' + job.name + '"');
  renderJobComments(job); // no-op unless job.id === editingJobId — see that function's own guard
  renderHomeJobChat();
  return reply;
}

export function addJobReply(jobId: string, commentId: string): void {
  const ta = document.getElementById('reply-ta-' + commentId) as HTMLTextAreaElement | null;
  const posted = postJobReply(jobId, commentId, ta ? ta.value : undefined);
  if (posted && ta) ta.value = '';
}

export function deleteJobReply(jobId: string, commentId: string, replyId: string): void {
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  const comment = ((job.comments as any[]) || []).find(function (c) { return c.id === commentId; });
  if (!comment) return;
  comment.replies = ((comment.replies as any[]) || []).filter(function (r) { return r.id !== replyId; });
  saveJobs();
  renderJobComments(job);
  renderHomeJobChat();
}

// Ctrl/Cmd+Enter posts the reply — mirrors handleJobCommentKey below.
export function handleReplyKey(event: KeyboardEvent, jobId: string, commentId: string): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addJobReply(jobId, commentId);
  }
}

// Shared by the drawer's own compose box and the Home Job Chat widget's
// (see postHomeJobChatComment() in home.ts) — same reasoning as
// postJobReply() above. Returns the new comment object, or null if
// nothing was posted.
export function postJobComment(jobId: string, text: string, important: boolean): any {
  const found = findJob(jobId);
  if (!found) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  let author = getStoredDisplayName();
  if (!author) {
    author = window.prompt('Your name (shown on comments):') || 'Team member';
    localStorage.setItem(DISPLAY_NAME_KEY, author);
  }

  const job = found.job;
  if (!Array.isArray(job.comments)) job.comments = [];
  const comment = { id: genId(), author: author, by: getStoredUsername(), text: trimmed, when: Date.now(), important: !!important };
  (job.comments as any[]).push(comment);
  saveJobs();
  logActivity('commented on job "' + job.name + '"' + (important ? ' (marked important)' : ''));
  renderJobComments(job); // no-op unless job.id === editingJobId — see that function's own guard
  renderJobList();
  renderHomeJobChat();
  return comment;
}

export function addJobComment(): void {
  if (!editingJobId) return;
  const textarea = document.getElementById('newJobCommentText') as HTMLTextAreaElement;
  const importantEl = document.getElementById('newJobCommentImportant') as HTMLInputElement | null;
  const posted = postJobComment(editingJobId, textarea.value, !!(importantEl && importantEl.checked));
  if (!posted) return;
  textarea.value = '';
  if (importantEl) importantEl.checked = false;
}

export function deleteJobComment(jobId: string, commentId: string): void {
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  job.comments = ((job.comments as any[]) || []).filter(function (c) { return c.id !== commentId; });
  saveJobs();
  renderJobComments(job);
  renderJobList();
  renderHomeJobChat();
}

// Ctrl/Cmd+Enter posts — plain Enter still inserts a newline, since comments
// are often more than one line.
export function handleJobCommentKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addJobComment();
  }
}

// Kept in sync with #jobCommentsPanel's own .collapsed (see
// editJob()/openJobDrawer() in src/views/job-form.ts) — otherwise the drawer stays
// its full two-panel width and the now-narrow collapsed panel just sits
// centered in a lot of dead space instead of the window actually getting
// smaller.
export function toggleJobCommentsPanel(): void {
  const panel = document.getElementById('jobCommentsPanel');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  const formArea = document.getElementById('formArea');
  if (formArea) formArea.classList.toggle('comments-collapsed', collapsed);
}
