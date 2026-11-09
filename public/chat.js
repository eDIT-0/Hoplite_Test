export function normalizeHistory(payload) {
  if (!payload || !Array.isArray(payload.messages)) {
    throw new Error('API не вернул список messages. Проверьте версию клиента и доступ thread:read.');
  }
  const messages = [];
  let skipped = 0;
  for (const item of payload.messages) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') {
      skipped++;
      continue;
    }
    // Accept missing kind for chat roles, but never expose tool/thinking records as chat.
    const kind = item.kind ?? (['user', 'assistant'].includes(item.role) ? 'chat' : 'unknown');
    if (!['chat', 'status'].includes(kind)) continue;
    messages.push({ ...item, kind, createdAt: typeof item.createdAt === 'string' ? item.createdAt : '' });
  }
  return {
    messages,
    skipped,
    nextCursor: payload.hasMore && typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
  };
}

export async function syncConversation({ api, id, query, onHistory, onThread }) {
  // Apply messages as soon as they arrive, independently of thread-state availability.
  const [history, detail] = await Promise.allSettled([
    api(`/api/threads/${id}/messages?${query}`).then(normalizeHistory).then(onHistory),
    api(`/api/threads/${id}`).then((data) => {
      if (!data?.thread?.id) throw new Error('API не вернул состояние диалога.');
      onThread(data.thread);
    }),
  ]);
  if (history.status === 'rejected') throw new Error(`Не удалось получить сообщения: ${history.reason.message}`);
  return detail.status === 'rejected' ? `Сообщения получены; статус диалога недоступен: ${detail.reason.message}` : null;
}
