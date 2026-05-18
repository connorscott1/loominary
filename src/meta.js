const MetaAIFlightParser = {
    extractFromHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const scripts = Array.from(doc.querySelectorAll('script'))
            .map(script => script.textContent || '')
            .filter(code => code.includes('self.__next_f.push'));
        const pushes = [];
        const sandboxSelf = { __next_f: { push: value => pushes.push(value) } };

        scripts.forEach(code => {
            const trimmed = code.trim();
            if (!trimmed.startsWith('self.__next_f.push(')) return;
            try {
                Function('self', trimmed)(sandboxSelf);
            } catch (error) {
                console.warn('[Meta AI] Failed to parse flight script:', error);
            }
        });

        const stream = pushes
            .filter(value => Array.isArray(value) && typeof value[1] === 'string')
            .map(value => value[1])
            .join('');
        const textRecords = this.parseTextRecords(stream);
        const conversationRecords = this.findConversationRecords(stream);
        const messageRecord = conversationRecords.find(record => {
            const messages = record.conversation?.messages?.edges;
            return Array.isArray(messages);
        });

        if (!messageRecord) {
            throw new Error('Meta AI conversation payload was not found in the page.');
        }

        const metadataRecord = conversationRecords.find(record =>
            record !== messageRecord && (record.conversation?.conversationId || record.conversation?.snapshotId)
        );
        const conversation = messageRecord.conversation;
        const metadata = metadataRecord?.conversation || {};
        const edges = conversation.messages.edges || [];
        const messages = edges.map((edge, index) => this.normalizeMessage(edge, index, textRecords));

        return {
            platform: 'meta',
            title: conversation.title || conversation.displayTitle || metadata.title || 'Meta AI conversation',
            id: conversation.id || metadata.id || '',
            conversationId: conversation.conversationId || metadata.conversationId || '',
            snapshotId: conversation.snapshotId || metadata.snapshotId || '',
            latestBranchPath: conversation.latestBranchPath || '',
            messages,
            conversationRecords: conversationRecords.map(record => ({
                recordId: record.recordId,
                keys: Object.keys(record.conversation || {}),
                messageEdges: Array.isArray(record.conversation?.messages?.edges) ? record.conversation.messages.edges.length : null,
                metadata: record.conversation && !record.conversation.messages ? {
                    id: record.conversation.id || '',
                    conversationId: record.conversation.conversationId || '',
                    snapshotId: record.conversation.snapshotId || '',
                    title: record.conversation.title || '',
                    viewerActionsLive: record.conversation.viewerActionsLive || [],
                    viewerActions: record.conversation.viewerActions || []
                } : null
            })),
            exportTime: new Date().toISOString()
        };
    },

    extractJsonAt(text, startIndex) {
        const start = text.indexOf('{', startIndex);
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
            } else if (char === '"') {
                inString = true;
            } else if (char === '{') {
                depth += 1;
            } else if (char === '}') {
                depth -= 1;
                if (depth === 0) return text.slice(start, index + 1);
            }
        }
        return null;
    },

    findConversationRecords(stream) {
        const records = [];
        let index = -1;
        while ((index = stream.indexOf('{"data":{"conversation"', index + 1)) >= 0) {
            const labelEnd = stream.lastIndexOf(':', index);
            const labelStart = Math.max(stream.lastIndexOf('\n', index) + 1, labelEnd - 8);
            const recordId = (stream.slice(labelStart, labelEnd).match(/[0-9a-f]+$/i) || [null])[0];
            const json = this.extractJsonAt(stream, index);
            if (!json) continue;
            try {
                const parsed = JSON.parse(json);
                if (parsed.data?.conversation) records.push({ recordId, conversation: parsed.data.conversation });
            } catch (error) {
                console.warn('[Meta AI] Failed to parse conversation record:', error);
            }
        }
        return records;
    },

    parseTextRecords(stream) {
        const records = new Map();
        const recordRe = /([0-9a-f]+):T([0-9a-f]+),/gi;
        let match;
        while ((match = recordRe.exec(stream)) !== null) {
            const id = match[1].toLowerCase();
            const length = Number.parseInt(match[2], 16);
            const start = match.index + match[0].length;
            const content = stream.slice(start, start + length);
            for (let index = 0; index <= Math.max(0, id.length - 2); index += 1) {
                const candidateId = id.slice(index);
                if (!records.has(candidateId)) records.set(candidateId, content);
            }
        }
        return records;
    },

    resolveValue(value, textRecords) {
        if (typeof value !== 'string') return value;
        const ref = value.match(/^\$([0-9a-f]+)$/i);
        if (!ref) return value;
        return textRecords.get(ref[1].toLowerCase()) || value;
    },

    cleanText(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    },

    normalizeAttachment(attachment) {
        return {
            id: attachment.id || '',
            file_name: attachment.filename || attachment.name || attachment.title || 'Meta AI attachment',
            file_size: attachment.size || 0,
            file_type: attachment.mimeType || attachment.contentType || '',
            url: attachment.uri || attachment.url || '',
            created_at: attachment.createdAt || attachment.created_at || ''
        };
    },

    normalizeMessage(edge, index, textRecords) {
        const node = edge.node || {};
        const isUser = node.__typename === 'UserMessage';
        const content = this.cleanText(this.resolveValue(node.content, textRecords));
        const userContent = this.cleanText(this.resolveValue(node.userContent, textRecords));
        const text = content || userContent;
        return {
            id: node.id || `meta_${index}`,
            turnId: node.turnId || '',
            sender: isUser ? 'human' : 'assistant',
            senderLabel: isUser ? 'User' : 'Meta AI',
            createdAt: node.createdAt || node.userCreatedAt || node.assistantCreatedAt || '',
            content: text,
            attachments: Array.isArray(node.attachments) ? node.attachments.map(this.normalizeAttachment) : [],
            branchPath: node.branchPath || '',
            rawType: node.__typename || ''
        };
    }
};

const MetaAIHandler = {
    init: () => {
        console.log('[Loominary] MetaAIHandler initialized');
    },

    getCurrentConversationId: () => {
        const match = window.location.pathname.match(/^\/prompt\/([^/?#]+)/);
        return match ? match[1] : null;
    },

    getConversation: async (conversationId) => {
        let html = document.documentElement?.outerHTML || '';
        if (!html.includes('self.__next_f.push') && conversationId) {
            const response = await fetch(`/prompt/${conversationId}`, {
                credentials: 'include',
                headers: { Accept: 'text/html' }
            });
            if (!response.ok) throw new Error(`Failed to fetch Meta AI prompt: ${response.status}`);
            html = await response.text();
        }

        const data = MetaAIFlightParser.extractFromHtml(html);
        data.id = data.id || conversationId || '';
        data.url = window.location.href;
        return data;
    },

    addButtons: (controls) => {
        controls.appendChild(Utils.createButton(
            `${previewIcon} ${i18n.t('viewOnline')}`,
            async (btn) => {
                const conversationId = MetaAIHandler.getCurrentConversationId();
                if (!conversationId) {
                    alert(i18n.t('uuidNotFound'));
                    return;
                }
                const original = btn.innerHTML;
                Utils.setButtonLoading(btn, i18n.t('loading'));
                try {
                    const data = await MetaAIHandler.getConversation(conversationId);
                    const filename = `meta_${Utils.sanitizeFilename(data.title)}_${conversationId.substring(0, 8)}.json`;
                    await Communicator.open(JSON.stringify(data, null, 2), filename);
                } catch (error) {
                    ErrorHandler.handle(error, 'Preview Meta AI conversation', {
                        userMessage: `${i18n.t('loadFailed')} ${error.message}`
                    });
                } finally {
                    Utils.restoreButton(btn, original);
                }
            }
        ));

        controls.appendChild(Utils.createButton(
            `${exportIcon} ${i18n.t('exportCurrentJSON')}`,
            async (btn) => {
                const conversationId = MetaAIHandler.getCurrentConversationId();
                if (!conversationId) {
                    alert(i18n.t('uuidNotFound'));
                    return;
                }
                const original = btn.innerHTML;
                Utils.setButtonLoading(btn, i18n.t('exporting'));
                try {
                    const data = await MetaAIHandler.getConversation(conversationId);
                    const filename = `meta_${Utils.sanitizeFilename(data.title)}_${conversationId.substring(0, 8)}`;
                    await loominaryExportMarkdown(data, filename);
                } catch (error) {
                    ErrorHandler.handle(error, 'Export Meta AI conversation');
                } finally {
                    Utils.restoreButton(btn, original);
                }
            }
        ));
    }
};
