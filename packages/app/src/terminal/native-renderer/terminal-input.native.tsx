import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  StyleSheet,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { resolveNativeTerminalKey, type NativeTerminalKey } from "./terminal-key-events";

export const TERMINAL_INPUT_CONTEXT_MENU_HIDDEN = true;
export const TERMINAL_INPUT_HITBOX_SIZE = 1;

export interface TerminalTextInputChange {
  data: string;
  key?: NativeTerminalKey;
  shouldClear: boolean;
}

export interface TerminalTextInputState {
  receiveKeyPress: (key: string) => TerminalTextInputChange;
  receiveTextChange: (text: string) => TerminalTextInputChange;
  reset: () => void;
}

export type TerminalInputFocusRequest = "focus" | "refocus" | "none";

export interface TerminalInputHandle {
  focus: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

interface TerminalInputProps {
  isKeyboardVisible: boolean;
  onFocus?: () => void;
  onInput?: (data: string) => void;
  onTerminalKey?: (key: NativeTerminalKey) => void;
  style?: StyleProp<TextStyle>;
}

// Only ASCII travels the keypress path. An IME script reports the jamo it is
// composing, which the text-change diff below immediately contradicts, so
// forwarding both would put two conflicting characters on the wire.
function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key <= "~";
}

function getCommonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * What the terminal receives for an edit that is not a plain append.
 * IMEs rewrite their composing suffix in place. Korean updates one
 * syllable at a time (`ㅎ` -> `하` -> `한`), while Chinese and Japanese replace
 * a multi-character reading (`nihao` -> `你好`, `にほんご` -> `日本語`). Latin
 * autocorrect does the same (`teh` -> `the`, `itll` -> `it'll`): the committed
 * word replaces already-typed text instead of appending to it. None of those
 * are appends, so rub out the rewritten suffix and send the replacement. This
 * keeps the terminal and the hidden buffer in lockstep; swallowing the edit
 * instead leaves them diverged, which silently disables Backspace until the
 * input resets (the reported "hit ESC to erase" symptom).
 *
 * Pure deletions through the text path (an IME removal with no keypress, so
 * the inserted suffix is empty) still swallow: there is no replacement text
 * to echo back, and a rubout there cannot be told apart from a stale one.
 */
function resolveCompositionEdit(
  previousText: string,
  text: string,
): {
  data: string;
  inserted: string;
} {
  const previousCharacters = Array.from(previousText);
  const nextCharacters = Array.from(text);
  const commonPrefixLength = getCommonPrefixLength(previousCharacters, nextCharacters);
  const removed = previousCharacters.slice(commonPrefixLength);
  const inserted = nextCharacters.slice(commonPrefixLength).join("");
  if (removed.length === 0 || inserted.length === 0) {
    return { data: "", inserted: "" };
  }
  return { data: `${"\x7f".repeat(removed.length)}${inserted}`, inserted };
}

export function resolveTerminalInputFocusRequest(input: {
  isInputFocused: boolean;
  isKeyboardVisible: boolean;
}): TerminalInputFocusRequest {
  if (!input.isInputFocused) {
    return "focus";
  }
  return input.isKeyboardVisible ? "none" : "refocus";
}

export function createTerminalTextInputState(): TerminalTextInputState {
  let previousText = "";
  let submittedText: string | null = null;
  // A swallowed replacement leaves the terminal holding text the buffer no
  // longer describes. A composition rubout deletes from the terminal, so it
  // would delete whatever is actually sitting there rather than the character
  // the buffer thinks it is replacing. Stay off until the input state resets.
  let replacementDesynced = false;
  // SwiftKey emits the text change before the keypress for the same character,
  // the reverse of the order the dedup below was written for (keypress first,
  // text change echoes it). Track the suffix the last text change already
  // forwarded so a late keypress for the same character is swallowed instead
  // of typed twice. Multi-character commits (swipe/autocomplete) queue here
  // and are consumed front-to-back as their keypresses arrive.
  let textForwardedPendingKeypress = "";

  return {
    receiveKeyPress(key: string): TerminalTextInputChange {
      const terminalKey = resolveNativeTerminalKey(key);
      if (terminalKey) {
        return { data: "", key: terminalKey, shouldClear: false };
      }
      if (key === "Backspace") {
        textForwardedPendingKeypress = "";
        previousText = Array.from(previousText).slice(0, -1).join("");
        if (replacementDesynced) {
          return { data: "", shouldClear: false };
        }
        return { data: "\x7f", shouldClear: false };
      }
      if (key === "Enter" || key === "Return" || key === "return") {
        textForwardedPendingKeypress = "";
        submittedText = previousText;
        return { data: "\r", shouldClear: true };
      }
      if (isPrintableKey(key)) {
        if (
          textForwardedPendingKeypress.length > 0 &&
          textForwardedPendingKeypress.startsWith(key)
        ) {
          textForwardedPendingKeypress = textForwardedPendingKeypress.slice(key.length);
          return { data: "", shouldClear: false };
        }
        textForwardedPendingKeypress = "";
        previousText += key;
        return { data: key, shouldClear: false };
      }
      return { data: "", shouldClear: false };
    },
    receiveTextChange(text: string): TerminalTextInputChange {
      if (submittedText !== null) {
        const lateSubmitText = `${submittedText}\n`;
        submittedText = null;
        if (text === lateSubmitText) {
          previousText = "";
          replacementDesynced = false;
          textForwardedPendingKeypress = "";
          return { data: "", shouldClear: false };
        }
      }

      if (text.length === 0) {
        previousText = "";
        textForwardedPendingKeypress = "";
        return { data: "", shouldClear: false };
      }

      if (text.includes("\n") || text.includes("\r")) {
        previousText = "";
        replacementDesynced = false;
        textForwardedPendingKeypress = "";
        return { data: "", shouldClear: true };
      }

      if (!text.startsWith(previousText)) {
        let compositionEdit = { data: "", inserted: "" };
        if (!replacementDesynced) {
          compositionEdit = resolveCompositionEdit(previousText, text);
        }
        previousText = text;
        if (compositionEdit.data === "") {
          replacementDesynced = true;
          textForwardedPendingKeypress = "";
        } else {
          // The rubout already reconciled the terminal with the buffer, so a
          // late keypress echoing the inserted suffix (SwiftKey) is deduped
          // through the same pending queue as appended text.
          textForwardedPendingKeypress = compositionEdit.inserted;
        }
        return { data: compositionEdit.data, shouldClear: false };
      }

      const appendedText = text.slice(previousText.length);
      previousText = text;
      if (appendedText.length > 0) {
        textForwardedPendingKeypress = appendedText;
      }
      return {
        data: appendedText,
        shouldClear: false,
      };
    },
    reset(): void {
      previousText = "";
      replacementDesynced = false;
      textForwardedPendingKeypress = "";
    },
  };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ isKeyboardVisible, onFocus, onInput, onTerminalKey, style }, ref) {
    const inputRef = useRef<EditingTextInputHandle>(null);
    const isFocusedRef = useRef(false);
    const pendingFocusFrameRef = useRef<number | null>(null);
    const inputState = useMemo(() => createTerminalTextInputState(), []);
    const inputStyle = useMemo(() => [styles.input, style], [style]);

    const clearPendingFocus = useCallback(() => {
      if (pendingFocusFrameRef.current === null) {
        return;
      }
      cancelAnimationFrame(pendingFocusFrameRef.current);
      pendingFocusFrameRef.current = null;
    }, []);

    const resetNativeInput = useCallback(() => {
      inputState.reset();
      inputRef.current?.replaceText("");
    }, [inputState]);

    const showNativeKeyboard = useCallback(() => {
      clearPendingFocus();
      const input = inputRef.current;
      if (!input) {
        return;
      }

      // Keep the native IME buffer aligned with the terminal. Some keyboards
      // do not emit a text change when a clipboard item replaces identical
      // stale input, so clear the buffer even when focus is already correct.
      resetNativeInput();

      const focusRequest = resolveTerminalInputFocusRequest({
        isInputFocused: isFocusedRef.current || input.isFocused(),
        isKeyboardVisible,
      });
      if (focusRequest === "none") {
        return;
      }

      if (focusRequest === "focus") {
        input.focus();
        return;
      }

      input.blur();
      isFocusedRef.current = false;
      input.focus();
      pendingFocusFrameRef.current = requestAnimationFrame(() => {
        pendingFocusFrameRef.current = null;
        inputRef.current?.focus();
      });
    }, [clearPendingFocus, isKeyboardVisible, resetNativeInput]);

    const blurNativeInput = useCallback(() => {
      clearPendingFocus();
      inputRef.current?.blur();
      isFocusedRef.current = false;
      resetNativeInput();
    }, [clearPendingFocus, resetNativeInput]);

    const focusNativeInput = useCallback(() => {
      showNativeKeyboard();
    }, [showNativeKeyboard]);

    useEffect(() => clearPendingFocus, [clearPendingFocus]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          focusNativeInput();
        },
        showKeyboard: () => {
          showNativeKeyboard();
        },
        blur: () => {
          blurNativeInput();
        },
      }),
      [blurNativeInput, focusNativeInput, showNativeKeyboard],
    );

    const handleFocus = useCallback(() => {
      isFocusedRef.current = true;
      onFocus?.();
    }, [onFocus]);

    const handleBlur = useCallback(() => {
      isFocusedRef.current = false;
      resetNativeInput();
    }, [resetNativeInput]);

    const handleChangeText = useCallback(
      (text: string) => {
        const change = inputState.receiveTextChange(text);
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          resetNativeInput();
        }
      },
      [inputState, onInput, resetNativeInput],
    );

    const handleKeyPress = useCallback(
      (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const change = inputState.receiveKeyPress(event.nativeEvent.key);
        if (change.key) {
          onTerminalKey?.(change.key);
        }
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          resetNativeInput();
        }
      },
      [inputState, onInput, onTerminalKey, resetNativeInput],
    );

    return (
      // No keyboardType prop: `ascii-capable` drops the globe key on iOS, which
      // is how you reach the Korean layout. Terminal safety comes from
      // autoCorrect/spellCheck/autoCapitalize being off, not from the layout.
      <TextInput
        ref={inputRef}
        accessibilityLabel="Terminal input"
        accessible={true}
        autoCapitalize="none"
        autoCorrect={false}
        caretHidden={true}
        contextMenuHidden={TERMINAL_INPUT_CONTEXT_MENU_HIDDEN}
        initialValue=""
        blurOnSubmit={false}
        importantForAutofill="no"
        multiline={true}
        onChangeText={handleChangeText}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        showSoftInputOnFocus={true}
        spellCheck={false}
        style={inputStyle}
        testID="terminal-native-input"
        textContentType="none"
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    backgroundColor: "transparent",
    color: "transparent",
    height: TERMINAL_INPUT_HITBOX_SIZE,
    left: 0,
    opacity: 0.01,
    padding: 0,
    position: "absolute",
    top: 0,
    width: TERMINAL_INPUT_HITBOX_SIZE,
  },
});
