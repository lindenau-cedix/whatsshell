/**
 * WhatsApp channel adapter.
 *
 * Wraps a whatsapp-web.js Client so the channel-agnostic router can stay
 * transport-free. Two responsibilities:
 *
 *   1. Normalise an incoming whatsapp-web.js message into the router's
 *      shape ({ channel, from, body, reply, metadata }).
 *   2. Provide a channel-specific reply() that calls client.sendMessage()
 *      for the original chatId.
 *
 * Group messages are dropped here (not in the router) because "what counts
 * as a group" is a WhatsApp-specific detail — SMS doesn't have groups.
 *
 * Decision: We bind via the `onMessage` factory instead of registering the
 * listener at module load so this module can be required without booting
 * a real client (helpful for tests).
 */

'use strict';

const { getLogger } = require('../logger');
const { isGroupMessage } = require('../whitelist');

/**
 * Extract the sender's phone number (digits only) from a whatsapp-web.js
 * message. Falls back to '' if the message shape is unexpected.
 *
 * Decision: Keep this here, not in the router. whatsapp-web.js's msg.from
 * is in E.164-with-@c.us-suffix format — that's a transport detail.
 */
function extractSender(msg) {
  if (!msg || typeof msg.from !== 'string') return '';
  return msg.from.split('@')[0].replace(/[^\d]/g, '');
}

/**
 * Build a channel-specific reply function for a given incoming message.
 *
 * For 1:1 chats we use msg.reply() (preserves the thread). The chatId is
 * captured in a closure so the router doesn't need to know about it.
 */
function buildReply(msg) {
  return async (text) => {
    await msg.reply(text);
  };
}

/**
 * Build a message-listener bound to the router.
 *
 * Returns a function suitable for `client.on('message', ...)`. Each call
 * is fire-and-forget — errors are caught and logged but do not crash the
 * event loop.
 *
 * @param {object} router   Result of createRouter()
 * @returns {Function}      (client, msg) => Promise<void>
 */
function createWhatsAppChannel(router) {
  const logger = getLogger();

  return async function onWhatsAppMessage(client, msg) {
    try {
      // Group messages are silently dropped here. The router never sees them.
      if (isGroupMessage(msg)) {
        logger.info('group_ignored', {
          channel: 'whatsapp',
          sender: extractSender(msg),
          body: typeof msg.body === 'string' ? msg.body.slice(0, 200) : '',
        });
        return;
      }

      await router.handleMessage({
        channel: 'whatsapp',
        from: extractSender(msg),
        body: typeof msg.body === 'string' ? msg.body : '',
        reply: buildReply(msg),
        metadata: {
          pushName: msg && msg._data && msg._data.notifyName
            ? msg._data.notifyName
            : undefined,
          messageId: msg && msg.id && msg.id.id ? msg.id.id : undefined,
        },
      });
    } catch (err) {
      logger.error(`Fehler im WhatsApp-Message-Handler: ${err.message}`, { stack: err.stack });
    }
  };
}

module.exports = {
  createWhatsAppChannel,
  extractSender,
};