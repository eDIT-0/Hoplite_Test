import { syncConversation } from './chat.js';

const $ = (id) => document.getElementById(id);
const state = { connected: false, busy: false, thread: null, revision: 0, messages: new Map(), cursor: null, threadCursor: null, pending: null, historyLoaded: false };
const statuses = { queued: 'В очереди', running: 'Агент работает', waiting: 'Ожидает действия', blocked: 'Требуется действие', ready: 'Готово', failed: 'Ошибка запуска', archived: 'В архиве' };
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function api(path, { body, key } = {}) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(35000),
    cache: 'no-store',
  });
  if (response.status === 204) return { ok: true };
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : `Ошибка API (${response.status})`);
  return data;
}

function controls() {
  const disabled = !state.connected || state.busy;
  for (const id of ['project', 'new-thread', 'refresh', 'model']) $(id).disabled = disabled;
  $('new-thread').disabled = disabled || !$('project').value;
  $('prompt').disabled = disabled || !$('project').value;
  $('send').disabled = disabled || !$('project').value || !$('prompt').value.trim();
  $('stop').disabled = disabled;
  $('send').textContent = state.busy ? 'Подождите…' : 'Отправить ↑';
  for (const button of $('threads').querySelectorAll('button')) button.disabled = disabled;
}

function resetThread() {
  state.revision++;
  state.thread = null;
  state.messages.clear();
  state.cursor = null;
  state.pending = null;
  $('title').textContent = 'Новый диалог';
  $('thread-status').textContent = 'Готов к новой задаче';
  $('current-model').textContent = 'Модель диалога: по умолчанию';
  $('usage').textContent = '';
  $('sync-status').textContent = 'Получение сообщений: выберите диалог';
  state.historyLoaded = false;
  $('stop').hidden = true;
  $('approval-note').hidden = true;
  $('older').hidden = true;
  $('prompt').value = '';
  $('model').value = '';
  renderMessages();
  for (const button of $('threads').querySelectorAll('button')) button.classList.remove('active');
  controls();
}

function addOptions(select, items, placeholder) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const item of items) select.add(new Option(item.name, item.id));
}

async function loadThreads(append = false) {
  const project = $('project').value;
  if (!project) return;
  const query = new URLSearchParams({ projectId: project, limit: '50', archived: 'false' });
  if (append && state.threadCursor) query.set('cursor', state.threadCursor);
  const result = await api(`/api/threads?${query}`);
  if ($('project').value !== project) return;
  if (!append) $('threads').replaceChildren();
  for (const thread of result.threads) {
    const button = document.createElement('button');
    button.textContent = thread.title || 'Без названия';
    button.dataset.id = thread.id;
    button.classList.toggle('active', state.thread?.id === thread.id);
    const status = document.createElement('small');
    status.textContent = statuses[thread.status] || thread.status;
    button.append(status);
    button.onclick = () => selectThread(thread);
    $('threads').append(button);
  }
  if (!$('threads').children.length) $('threads').textContent = 'Пока нет диалогов.';
  state.threadCursor = result.nextCursor;
  $('more-threads').hidden = !result.nextCursor;
  controls();
}

async function selectThread(thread) {
  if (state.busy) return;
  resetThread();
  state.thread = thread;
  showThread(thread);
  for (const button of $('threads').querySelectorAll('button')) button.classList.toggle('active', button.dataset.id === thread.id);
  notice();
  try { await Promise.all([refreshThread(), refreshUsage()]); } catch (error) { notice(error.message); }
}

function showThread(thread) {
  $('title').textContent = thread.title || 'Без названия';
  $('thread-status').textContent = statuses[thread.status] || thread.status;
  $('current-model').textContent = `Модель диалога: ${thread.modelId || 'по умолчанию'}`;
  $('stop').hidden = !['queued', 'running', 'waiting'].includes(thread.runStatus);
  $('approval-note').hidden = !['waiting', 'blocked'].includes(thread.status);
}

function textWithLinks(element, content) {
  const parts = content.split(/(https?:\/\/[^\s<>]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      element.append(a);
    } else element.append(document.createTextNode(part));
  }
}

function renderMessages() {
  const container = $('conversation');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  $('messages').replaceChildren();
  const messages = [...state.messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const message of messages) {
    if (!['chat', 'status'].includes(message.kind)) continue;
    const article = document.createElement('article');
    article.className = `message ${message.role === 'user' ? 'user' : message.kind === 'status' ? 'status' : 'assistant'}`;
    const header = document.createElement('header');
    const name = message.role === 'user' ? 'Вы' : message.role === 'assistant' ? 'Hoplite' : 'Система';
    const date = new Date(message.createdAt);
    header.textContent = Number.isNaN(date.getTime()) ? name : `${name} · ${date.toLocaleString('ru-RU')}`;
    const content = document.createElement('div');
    content.className = 'content';
    textWithLinks(content, message.content);
    article.append(header, content);
    $('messages').append(article);
  }
  if (!$('messages').children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const heading = document.createElement('h2');
    heading.textContent = state.thread ? 'Пока нет сообщений' : 'Над чем поработаем?';
    const description = document.createElement('p');
    description.textContent = state.thread ? 'Сохранённые ответы появятся здесь автоматически.' : 'Выберите проект и опишите задачу.';
    empty.append(heading, description);
    $('messages').append(empty);
  }
  if (atBottom) container.scrollTop = container.scrollHeight;
}

async function refreshThread(older = false) {
  if (!state.thread) return;
  const revision = state.revision;
  const id = encodeURIComponent(state.thread.id);
  const query = new URLSearchParams({ limit: '100', activityLimit: '50' });
  if (older && state.cursor) query.set('cursor', state.cursor);
  $('sync-status').textContent = 'Получение сообщений…';
  try {
    const warning = await syncConversation({
      api, id, query,
      onThread(thread) {
        if (revision !== state.revision) return;
        state.thread = thread;
        showThread(thread);
      },
      onHistory(history) {
        if (revision !== state.revision) return;
        const firstLoad = !state.historyLoaded;
        let changed = false;
        for (const message of history.messages) {
          if (JSON.stringify(state.messages.get(message.id)) !== JSON.stringify(message)) changed = true;
          state.messages.set(message.id, message);
        }
        if (firstLoad || older) state.cursor = history.nextCursor;
        state.historyLoaded = true;
        $('older').hidden = !state.cursor;
        if (changed || firstLoad) renderMessages();
        const time = new Date().toLocaleTimeString('ru-RU');
        $('sync-status').textContent = `Синхронизировано ${time} · сообщений: ${state.messages.size}`
          + (history.skipped ? ` · пропущено некорректных: ${history.skipped}` : '');
      },
    });
    if (revision === state.revision && warning) $('sync-status').textContent = warning;
  } catch (error) {
    if (revision !== state.revision) return;
    $('sync-status').textContent = error.message;
    throw error;
  }
}

async function refreshBilling() {
  try {
    const { billing } = await api('/api/billing/summary');
    $('credits').textContent = billing.available && typeof billing.remainingCredits === 'number' ? number.format(billing.remainingCredits) : 'Недоступно';
    $('held').textContent = billing.available ? `Зарезервировано: ${number.format(billing.heldCredits ?? 0)}` : 'API не предоставил баланс';
  } catch {
    $('credits').textContent = 'Недоступно';
    $('held').textContent = 'Проверьте право usage:read';
  }
}

async function refreshUsage() {
  if (!state.thread) return;
  const revision = state.revision;
  try {
    const { usage } = await api(`/api/threads/${encodeURIComponent(state.thread.id)}/usage`);
    if (revision === state.revision) $('usage').textContent = typeof usage.totalCostMicros === 'number' ? `Расход: $${number.format(usage.totalCostMicros / 1e6)}` : 'Расход: нет данных';
  } catch { if (revision === state.revision) $('usage').textContent = 'Расход недоступен'; }
}

$('composer').onsubmit = async (event) => {
  event.preventDefault();
  if (state.busy || !state.connected || !$('project').value || !$('prompt').value.trim()) return;
  const content = $('prompt').value.trim();
  const path = state.thread ? `/api/threads/${encodeURIComponent(state.thread.id)}/messages` : '/api/threads';
  const body = state.thread ? { content } : { projectId: $('project').value, prompt: content };
  if ($('model').value) body.model = $('model').value;
  const signature = JSON.stringify({ path, body });
  // Preserve the same key after an uncertain response, so retrying cannot start a duplicate run.
  if (state.pending?.signature !== signature) state.pending = { signature, key: crypto.randomUUID() };
  state.busy = true;
  controls();
  notice();
  let sent = false;
  try {
    const result = await api(path, { body, key: state.pending.key });
    sent = true;
    state.pending = null;
    $('prompt').value = '';
    if (result.thread) { state.thread = result.thread; state.revision++; state.historyLoaded = false; showThread(result.thread); }
    await Promise.all([loadThreads(), refreshThread(), refreshBilling(), refreshUsage()]);
  } catch (error) {
    notice(sent ? `Задача отправлена, но обновить данные не удалось: ${error.message}` : `${error.message}\nЕсли ответ потерялся, повторите отправку без изменения текста: будет использован тот же идентификатор запроса.`);
  } finally { state.busy = false; controls(); }
};
$('prompt').oninput = controls;
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('composer').requestSubmit(); }
};
$('new-thread').onclick = () => { resetThread(); notice(); $('prompt').focus(); };
$('project').onchange = async () => {
  resetThread();
  $('threads').replaceChildren();
  $('more-threads').hidden = true;
  state.threadCursor = null;
  try { await loadThreads(); notice(); } catch (error) { notice(error.message); }
};
$('more-threads').onclick = async () => {
  $('more-threads').disabled = true;
  try { await loadThreads(true); } catch (error) { notice(error.message); }
  finally { $('more-threads').disabled = false; }
};
$('older').onclick = async () => {
  $('older').disabled = true;
  try { await refreshThread(true); } catch (error) { notice(error.message); }
  finally { $('older').disabled = false; }
};
$('refresh').onclick = async () => {
  try { await Promise.all([loadThreads(), refreshThread(), refreshBilling(), refreshUsage()]); notice(); }
  catch (error) { notice(error.message); }
};
$('stop').onclick = async () => {
  if (state.busy || !state.thread) return;
  state.busy = true;
  controls();
  try {
    const path = `/api/threads/${encodeURIComponent(state.thread.id)}`;
    const { activeRun } = await api(`${path}/active-run`);
    if (activeRun) await api(`${path}/stop`, { body: { runId: activeRun.runId }, key: crypto.randomUUID() });
    notice(activeRun ? 'Запрос на остановку отправлен.' : 'Активного запуска уже нет.');
    await refreshThread();
  } catch (error) { notice(error.message); }
  finally { state.busy = false; controls(); }
};

async function init() {
  try {
    const { configured } = await api('/local/status');
    $('setup').hidden = configured;
    $('conversation').hidden = !configured;
    if (!configured) return;
    const projects = [];
    let cursor;
    do {
      const query = new URLSearchParams({ pagination: 'cursor', limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await api(`/api/projects?${query}`);
      projects.push(...page.projects);
      cursor = page.nextCursor;
    } while (cursor);
    addOptions($('project'), projects, 'Выберите проект');
    state.connected = true;
    $('thread-status').textContent = 'Подключено';
    controls();
    if (!projects.length) notice('Нет доступных проектов. Создайте проект в Hoplite или проверьте доступ ключа.');
    await refreshBilling();
    try {
      const catalog = await api('/api/model-providers');
      addOptions($('model'), catalog.models, 'По умолчанию');
    } catch { notice('Каталог моделей недоступен. Можно отправлять задачи с моделью по умолчанию.'); }
  } catch (error) { notice(`Не удалось подключиться: ${error.message}. Проверьте .env и перезапустите сервер.`); }
}
let ticks = 0;
let pollError = null;
async function poll() {
  if (state.connected && !state.busy && !document.hidden) {
    try {
      await refreshThread();
      if (++ticks % 6 === 0) await Promise.all([loadThreads(), refreshBilling(), refreshUsage()]);
      if (pollError && $('notice').textContent === pollError) notice();
      pollError = null;
    } catch (error) {
      pollError = `Не удалось обновить данные: ${error.message}. Повторим автоматически.`;
      notice(pollError);
    }
  }
  setTimeout(poll, 5000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.connected && !state.busy) {
    refreshThread().catch((error) => notice(error.message));
  }
});
await init();
poll();
