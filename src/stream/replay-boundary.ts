import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export class ReplayBoundary {
  private replaySafe = true;

  observe(event: AssistantMessageEvent): void {
    if (
      event.type === "text_start" ||
      event.type === "text_delta" ||
      event.type === "text_end" ||
      event.type === "thinking_start" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_end" ||
      event.type === "toolcall_start" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end"
    ) {
      this.replaySafe = false;
    }
  }

  isReplaySafe(): boolean {
    return this.replaySafe;
  }
}
