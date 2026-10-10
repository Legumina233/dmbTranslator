import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

export type SelectOption<T extends string> = {
  value: T;
  label: string;
};

type SelectPlacement = 'down' | 'up';

const selectCurrentValueIndex = -1;
const selectRowHeight = 31;
const selectMenuMaxHeight = 191;
const selectMenuChromeHeight = 1;

export function SelectControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectCurrentValueIndex);
  const [placement, setPlacement] = useState<SelectPlacement>('down');
  const [menuMaxHeight, setMenuMaxHeight] = useState(selectMenuMaxHeight);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId();
  const listboxId = `select-listbox-${generatedId}`;
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const availableOptions = options.filter((option) => option.value !== value);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || activeIndex === selectCurrentValueIndex) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function getVisualOptionIndices(targetPlacement: SelectPlacement): number[] {
    const optionIndices = availableOptions.map((_, index) => index);
    return targetPlacement === 'down'
      ? [selectCurrentValueIndex, ...optionIndices]
      : [...optionIndices, selectCurrentValueIndex];
  }

  function openMenu(): SelectPlacement | null {
    if (availableOptions.length === 0) return null;

    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const popupRect = rootRef.current?.closest('.popup')?.getBoundingClientRect();
    let nextPlacement = placement;
    if (triggerRect) {
      const boundaryTop = Math.max(0, popupRect?.top ?? 0);
      const boundaryBottom = Math.min(window.innerHeight, popupRect?.bottom ?? window.innerHeight);
      const spaceAbove = Math.max(0, triggerRect.top - boundaryTop);
      const spaceBelow = Math.max(0, boundaryBottom - triggerRect.bottom);
      const desiredHeight = Math.min(
        selectMenuMaxHeight,
        availableOptions.length * selectRowHeight + selectMenuChromeHeight,
      );
      nextPlacement =
        spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
      const availableHeight = nextPlacement === 'down' ? spaceBelow : spaceAbove;

      setPlacement(nextPlacement);
      setMenuMaxHeight(Math.max(
        selectRowHeight + selectMenuChromeHeight,
        Math.min(selectMenuMaxHeight, Math.floor(availableHeight)),
      ));
    }

    setActiveIndex(selectCurrentValueIndex);
    setOpen(true);
    return nextPlacement;
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function selectOption(index: number): void {
    if (index === selectCurrentValueIndex) {
      closeMenu(true);
      return;
    }
    const option = availableOptions[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  }

  function moveActiveOption(direction: 1 | -1): void {
    if (!open) {
      openMenu();
      return;
    }
    if (availableOptions.length === 0) return;
    const visualIndices = getVisualOptionIndices(placement);
    setActiveIndex((current) => {
      const currentPosition = visualIndices.indexOf(current);
      const nextPosition = (
        Math.max(0, currentPosition) + direction + visualIndices.length
      ) % visualIndices.length;
      return visualIndices[nextPosition];
    });
  }

  function moveActiveToBoundary(boundary: 'start' | 'end'): void {
    const targetPlacement = open ? placement : openMenu();
    if (!targetPlacement) return;
    const visualIndices = getVisualOptionIndices(targetPlacement);
    setActiveIndex(boundary === 'start' ? visualIndices[0] : visualIndices[visualIndices.length - 1]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActiveOption(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActiveOption(-1);
        break;
      case 'Home':
        event.preventDefault();
        moveActiveToBoundary('start');
        break;
      case 'End':
        event.preventDefault();
        moveActiveToBoundary('end');
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) selectOption(activeIndex);
        else openMenu();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu();
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const query = event.key.toLocaleLowerCase();
          const availableMatchIndex = availableOptions.findIndex(
            (option) => option.label.toLocaleLowerCase().startsWith(query),
          );
          const matchIndex = selectedOption?.label.toLocaleLowerCase().startsWith(query)
            ? selectCurrentValueIndex
            : availableMatchIndex >= 0
              ? availableMatchIndex
              : null;
          if (matchIndex !== null) {
            event.preventDefault();
            if (!open) openMenu();
            setActiveIndex(matchIndex);
          }
        }
    }
  }

  return (
    <div
      className="select-root"
      data-open={open}
      data-placement={placement}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${
          open && activeIndex === selectCurrentValueIndex ? ' select-trigger-active' : ''
        }`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && activeIndex !== selectCurrentValueIndex
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        onPointerMove={() => {
          if (open) setActiveIndex(selectCurrentValueIndex);
        }}
      >
        <span className="select-value">{selectedOption?.label ?? ''}</span>
        <svg
          className="select-chevron"
          viewBox="0 0 12 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m1.5 1.5 4.5 4.5 4.5-4.5" />
        </svg>
      </button>
      <div
        className="select-menu"
        aria-hidden={!open}
      >
        <div
          id={listboxId}
          className="select-options-scroll"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            maxHeight: Math.max(selectRowHeight, menuMaxHeight - selectMenuChromeHeight),
          }}
        >
          {availableOptions.map((option, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                className={`select-option${active ? ' select-option-active' : ''}`}
                role="option"
                aria-selected="false"
                tabIndex={-1}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => selectOption(index)}
              >
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
