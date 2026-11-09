import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, syncConversation } from '../public/chat.js';

const message = (id, content, extra = {}) => ({ id, content, role: 'assistant', kind: 'chat', createdAt: '2026-11-09T18:00:00Z', ...extra });

test('chat and status remain visible; tool and thinking messages stay excluded', () => {
  const result = normalizeHistory({ messages: [message('a', 'Ответ'), message('b', 'Ход работы', { kind: 'status' }), message('c', 'Tool', { kind: 'tool' }), message('d', 'Thinking', { kind: 'thinking' })] });
  assert.deepEqual(result.messages.map(({ id }) => id), ['a', 'b']);
});

test('missing kind does not silently drop user/assistant replies; missing timestamps do not crash sorting', () => {
  const result = normalizeHistory({ messages: [message('a', 'Ответ', { kind: null, createdAt: null }), message('b', 'Запрос', { kind: undefined, role: 'user' }), message('c', 'Tool', { kind: undefined, role: 'tool' })] });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].kind, 'chat');
  assert.equal(result.messages[0].createdAt, '');
});

test('bad individual records are counted without hiding valid replies; invalid envelopes fail visibly', () => {
  const history = normalizeHistory({ messages: [null, { id: 'bad', content: {} }, message('good', 'Ответ')] });
  assert.equal(history.skipped, 2);
  assert.equal(history.messages[0].content, 'Ответ');
  assert.throws(() => normalizeHistory({ data: [] }), /messages/);
});

test('backward pagination respects opaque nextCursor', () => {
  assert.equal(normalizeHistory({ messages: [], hasMore: true, nextCursor: 'opaque' }).nextCursor, 'opaque');
  assert.equal(normalizeHistory({ messages: [], hasMore: false, nextCursor: 'opaque' }).nextCursor, null);
});

test('new assistant replies are delivered across repeated polls without depending on thread status', async () => {
  let responses = [message('user', 'Задача', { role: 'user' })];
  const rendered = new Map();
  const config = {
    id: 'thread', query: new URLSearchParams({ limit: '100' }),
    api: async (url) => url.includes('/messages?') ? { messages: responses } : { thread: { id: 'thread', status: 'running' } },
    onHistory: ({ messages }) => { for (const item of messages) rendered.set(item.id, item.content); },
    onThread: () => {},
  };
  await syncConversation(config);
  assert.equal(rendered.size, 1);
  responses = [...responses, message('reply', 'Полученный ответ')];
  await syncConversation(config);
  await syncConversation(config);
  assert.equal(rendered.size, 2);
  assert.equal(rendered.get('reply'), 'Полученный ответ');
});

test('thread detail failure cannot discard successfully received history', async () => {
  let visible;
  const warning = await syncConversation({
    id: 'thread', query: '',
    api: async (url) => { if (!url.includes('/messages?')) throw new Error('HTTP 503'); return { messages: [message('reply', 'Ответ')] }; },
    onHistory: ({ messages }) => { visible = messages[0].content; }, onThread: () => assert.fail('No detail'),
  });
  assert.equal(visible, 'Ответ');
  assert.match(warning, /статус диалога недоступен/);
});

test('history renders even while a detail request remains pending', async () => {
  let resolveDetail;
  const detail = new Promise((resolve) => { resolveDetail = resolve; });
  let applied;
  const rendered = new Promise((resolve) => { applied = resolve; });
  const sync = syncConversation({ id: 'thread', query: '', api: (url) => url.includes('/messages?') ? Promise.resolve({ messages: [message('reply', 'Ответ')] }) : detail, onHistory: applied, onThread: () => {} });
  assert.equal((await rendered).messages[0].content, 'Ответ');
  resolveDetail({ thread: { id: 'thread' } });
  await sync;
});

test('message authorization failures are surfaced rather than reported as a successful sync', async () => {
  await assert.rejects(syncConversation({ id: 'thread', query: '', api: async (url) => {
    if (url.includes('/messages?')) throw new Error('thread:read required');
    return { thread: { id: 'thread' } };
  }, onThread: () => {}, onHistory: () => assert.fail('No history') }), /Не удалось получить сообщения: thread:read required/);
});
