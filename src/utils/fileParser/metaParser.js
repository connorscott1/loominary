// metaParser.js
// Meta AI platform parser for Loominary userscript exports

import {
  MessageBuilder,
  DateTimeUtils
} from './helpers.js';

export const extractMetaData = (jsonData) => {
  const title = jsonData.title || 'Meta AI conversation';
  const exportTime = DateTimeUtils.formatDateTime(jsonData.exportTime);
  const conversationId = jsonData.id || jsonData.conversationId || '';

  const metaInfo = {
    title,
    created_at: exportTime,
    updated_at: exportTime,
    uuid: conversationId,
    conversation_id: jsonData.conversationId || '',
    snapshot_id: jsonData.snapshotId || '',
    model: 'Meta AI',
    platform: 'meta',
    has_embedded_images: false,
    images_processed: 0
  };

  const messages = Array.isArray(jsonData.messages) ? jsonData.messages : [];
  const chatHistory = messages.map((message, index) => {
    const isHuman = message.sender === 'human' || message.role === 'User';
    const previous = index > 0 ? messages[index - 1] : null;
    const messageData = new MessageBuilder(
      index,
      message.id || `meta_msg_${index}`,
      message.parentMessageId || previous?.id || '',
      isHuman ? 'human' : 'assistant',
      isHuman ? 'User' : 'Meta AI',
      DateTimeUtils.formatDateTime(message.createdAt)
    ).build();

    const text = message.content || message.text || '';
    messageData.raw_text = text;
    messageData.display_text = text;

    if (message.turnId) messageData.turn_id = message.turnId;
    if (message.branchPath) messageData.branch_path = message.branchPath;
    if (Array.isArray(message.attachments)) messageData.attachments = message.attachments;
    if (Array.isArray(message.citations)) messageData.citations = message.citations;

    return messageData;
  });

  return {
    meta_info: metaInfo,
    chat_history: chatHistory,
    raw_data: jsonData,
    format: 'meta',
    platform: 'meta'
  };
};

export const detectMetaBranches = (processedData) => {
  if (!processedData?.chat_history) return processedData;
  processedData.chat_history.forEach(message => {
    message.branch_id = 'main';
    message.branch_level = 0;
    message.is_branch_point = false;
  });
  return processedData;
};
