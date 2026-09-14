export function blocksCaptureShortcut(target: EventTarget | null, modalOpen: boolean) {
  const element = target as HTMLElement | null;
  return modalOpen || !!element?.closest?.(
    'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], [role="alertdialog"]',
  );
}

export function createButtonStartShortcut(options: {
  isAllowed: () => boolean;
  isBlocked: (target: EventTarget | null) => boolean;
  trigger: () => void;
}) {
  let held = false;
  return {
    keydown(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'target' | 'preventDefault' | 'defaultPrevented' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey'>) {
      if (event.code !== 'Space') return;
      const wasHeld = held;
      held = true;
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
          !options.isAllowed() || options.isBlocked(event.target)) return;
      event.preventDefault();
      if (!wasHeld && !event.repeat) options.trigger();
    },
    keyup(event: Pick<KeyboardEvent, 'code'>) { if (event.code === 'Space') held = false; },
    blur() { held = false; },
  };
}
