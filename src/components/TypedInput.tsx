"use client";
import { useImperativeHandle, useRef, type Ref } from "react";
import { Send } from "lucide-react";

export type TypedInputHandle = {
  /** Put text in the box and focus it (used by the "Try saying…" chips). */
  prefill: (text: string) => void;
};

/**
 * The typed box. Voice is the hero; this is the guarantee that VIVA never
 * *requires* a microphone.
 *
 * HYDRATION INVARIANT — the input is uncontrolled on purpose.
 *
 * This markup is server-rendered, so it is on screen and focusable a beat
 * before React hydrates. A student who starts typing in that window used to
 * lose everything they wrote: React reconciled a controlled `value=""` over
 * the live DOM node, blanked the field, and Send then submitted an empty
 * string with no error. Reproduced 4/4 on a production build.
 *
 * The fix is to let the DOM own the value. There is no `value` prop and no
 * `onChange` state write, so hydration has nothing to reconcile and nothing
 * to erase; submit reads `ref.current.value` — the same value the student can
 * see — at the moment they press Send. Do not reintroduce a controlled value
 * here: `tests/typed-input.test.ts` fails if you do.
 */
export function TypedInput({
  onSubmit,
  disabled = false,
  placeholder = "Or type what you're thinking",
  handleRef,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  handleRef?: Ref<TypedInputHandle>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(handleRef, () => ({
    prefill(text: string) {
      const el = inputRef.current;
      if (!el) return;
      el.value = text;
      el.focus();
    },
  }), []);

  function submit() {
    const el = inputRef.current;
    const text = el?.value.trim() ?? "";
    if (!text || disabled) return;
    onSubmit(text);
    if (el) el.value = "";
  }

  return (
    <div className="flex gap-2">
      <label htmlFor="viva-type" className="sr-only">
        Type instead of speaking
      </label>
      <input
        id="viva-type"
        ref={inputRef}
        type="text"
        autoComplete="off"
        defaultValue=""
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="min-h-11 w-full min-w-0 rounded-lg border hairline px-4 py-3 text-base disabled:opacity-60"
        style={{ background: "var(--color-panel)", color: "var(--color-paper)" }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        className="btn-ghost shrink-0 !px-4"
      >
        <Send size={16} aria-hidden />
        Send
      </button>
    </div>
  );
}
