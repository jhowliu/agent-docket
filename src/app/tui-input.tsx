import { useState } from 'react';
import { Text, useInput, usePaste } from 'ink';
import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';

export const terminalText = (text: string): string =>
  stripVTControlCharacters(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    '',
  );
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) =>
  Array.from(segments.segment(text), (part) => part.segment);

/** Single-line terminal editing; bracketed paste never enters the navigation channel. */
export function PromptInput(props: {
  id: string;
  active: boolean;
  value: string;
  width: number;
  maxLength?: number;
  onHorizontalArrow?: (direction: 'left' | 'right') => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
}) {
  const { id, active, value, width, onChange, onSubmit, onEscape } = props;
  const chars = graphemes(value);
  const [position, setPosition] = useState({ id, offset: chars.length });
  const cursor =
    position.id === id ? Math.min(position.offset, chars.length) : chars.length;
  function move(offset: number) {
    setPosition({ id, offset });
  }
  function insert(text: string) {
    const added = graphemes(terminalText(text).replace(/[\r\n\t]/g, ' '));
    const next = [
      ...chars.slice(0, cursor),
      ...added,
      ...chars.slice(cursor),
    ].join('');
    if (next.length > (props.maxLength ?? 1000)) return;
    onChange(next);
    move(cursor + added.length);
  }
  usePaste((text) => {
    if (active) insert(text);
  });
  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;
      if (key.escape) {
        onEscape();
        return;
      }
      if (key.return) {
        if (key.eventType !== 'repeat') onSubmit();
        return;
      }
      if (key.ctrl) {
        if (input === 'a') move(0);
        else if (input === 'e') move(chars.length);
        else if (input === 'u') {
          onChange(chars.slice(cursor).join(''));
          move(0);
        }
        return;
      }
      if (
        key.meta ||
        key.super ||
        key.hyper ||
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown
      )
        return;
      if (key.leftArrow || key.rightArrow) {
        if (props.onHorizontalArrow)
          props.onHorizontalArrow(key.leftArrow ? 'left' : 'right');
        else
          move(
            Math.max(
              0,
              Math.min(chars.length, cursor + (key.leftArrow ? -1 : 1)),
            ),
          );
      } else if (key.home) move(0);
      else if (key.end) move(chars.length);
      else if (key.backspace && cursor > 0) {
        onChange(
          [...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''),
        );
        move(cursor - 1);
      } else if (key.delete) {
        onChange(
          [...chars.slice(0, cursor), ...chars.slice(cursor + 1)].join(''),
        );
      } else if (input) insert(input);
    },
    { isActive: active },
  );
  if (!active) return null;
  let start = cursor;
  let used = stringWidth(chars[cursor] ?? ' ');
  while (
    start > 0 &&
    used + stringWidth(chars[start - 1] ?? '') < Math.max(1, width - 1)
  ) {
    start--;
    used += stringWidth(chars[start] ?? '');
  }
  const before = chars.slice(start, cursor).join('');
  const caret = chars[cursor] ?? ' ';
  let after = '';
  for (const char of chars.slice(cursor + 1)) {
    if (used + stringWidth(char) >= width) break;
    after += char;
    used += stringWidth(char);
  }
  return (
    <Text wrap="truncate-end">
      {before}
      <Text inverse>{caret}</Text>
      {after}
    </Text>
  );
}
