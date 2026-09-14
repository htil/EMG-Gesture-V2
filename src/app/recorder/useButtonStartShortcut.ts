import { useEffect, useRef } from 'react';
import { blocksCaptureShortcut, createButtonStartShortcut } from './buttonStartShortcut';

export function useButtonStartShortcut(allowed: boolean, trigger: () => void) {
  const current = useRef({ allowed, trigger });
  current.current = { allowed, trigger };
  useEffect(() => {
    const shortcut = createButtonStartShortcut({
      isAllowed: () => current.current.allowed,
      isBlocked: target => blocksCaptureShortcut(target,
        [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
          .some(element => element.getClientRects().length > 0)),
      trigger: () => current.current.trigger(),
    });
    window.addEventListener('keydown', shortcut.keydown);
    window.addEventListener('keyup', shortcut.keyup);
    window.addEventListener('blur', shortcut.blur);
    return () => {
      window.removeEventListener('keydown', shortcut.keydown);
      window.removeEventListener('keyup', shortcut.keyup);
      window.removeEventListener('blur', shortcut.blur);
    };
  }, []);
}
