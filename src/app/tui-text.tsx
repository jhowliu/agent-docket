import { createContext, useContext } from 'react';
import type { ComponentProps } from 'react';
import { Box as InkBox, Text as InkText } from 'ink';

/** True behind an open modal: workspace text and borders render dimmed. */
export const Backdrop = createContext(false);

/**
 * Ink Text that dims while a modal is in front of it. Bold is dropped there:
 * bold and dim share one reset code, so the text after a bold run lost its dim.
 */
export function Text(props: ComponentProps<typeof InkText>) {
  const dimmed = useContext(Backdrop);
  return (
    <InkText
      {...props}
      dimColor={dimmed || props.dimColor === true}
      bold={!dimmed && props.bold === true}
    />
  );
}

/** Ink Box whose border dims while a modal is in front of it. */
export function Box(props: ComponentProps<typeof InkBox>) {
  const dimmed = useContext(Backdrop);
  return (
    <InkBox
      {...props}
      borderDimColor={dimmed || props.borderDimColor === true}
    />
  );
}
