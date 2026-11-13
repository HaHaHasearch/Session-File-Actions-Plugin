import { MessageAttachmentCard, Plugin } from "@opencode/plugin/gui";
import { Identity } from "./ipc";
import { identify } from "./main/identity";
import { bindAttachmentCard } from "./renderer/attachment-card";

export default Plugin.define({
  i18n: { en: {
    "identity.failed": "Could not identify this attachment",
    "identity.failed.description": "Try again or check the plugin logs.",
  } },
  setup(ctx) {
    if (!ctx.desktop) return;
    if (!MessageAttachmentCard) throw new Error("This plugin requires the patched OpenCode message attachment API");
    const bridge = ctx.main(Identity);
    ctx.add(MessageAttachmentCard, {
      bind(input) {
        return bindAttachmentCard({
          element: input.element,
          location: {
            host: "opencode",
            hostInstanceId: input.session.server.id,
            sessionId: input.session.id,
            messageId: input.messageID,
            attachmentId: input.attachmentID,
          },
          signal: ctx.signal,
          identify: (location, options) => bridge.identify(location, options),
          toast: ctx.toast,
          translate: (key) => ctx.t(key),
        });
      },
    });
  },
  main(ctx) {
    ctx.provide(Identity, { identify });
  },
});
