import { Ipc } from "@opencode/plugin/gui";
import { Schema } from "effect";

const IdentityResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("identified"), key: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("invalid"),
    reason: Schema.Literals(["invalid_location", "invalid_attachment"]),
  }),
]);
export type IdentityResult = typeof IdentityResult.Type;

export const Identity = Ipc.define({
  id: "opencode-session-file-actions.identity",
  methods: {
    identify: {
      input: Schema.Struct({
        host: Schema.Literal("opencode"),
        hostInstanceId: Schema.String,
        sessionId: Schema.String,
        messageId: Schema.String,
        attachmentId: Schema.String,
      }),
      output: IdentityResult,
    },
  },
});
