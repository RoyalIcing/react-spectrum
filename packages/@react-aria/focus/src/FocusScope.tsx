/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {focusSafely} from './focusSafely';
import {isElementVisible} from './isElementVisible';
import React, {ReactNode, RefObject, useContext, useEffect, useRef} from 'react';
import {useLayoutEffect} from '@react-aria/utils';

// import {FocusScope, useFocusScope} from 'react-events/focus-scope';
// export {FocusScope};

interface FocusScopeProps {
  /** The contents of the focus scope. */
  children: ReactNode,

  /**
   * Whether to contain focus inside the scope, so users cannot
   * move focus outside, for example in a modal dialog.
   */
  contain?: boolean,

  /**
   * Whether to restore focus back to the element that was focused
   * when the focus scope mounted, after the focus scope unmounts.
   */
  restoreFocus?: boolean,

  /** Whether to auto focus the first focusable element in the focus scope on mount. */
  autoFocus?: boolean
}

interface FocusManagerOptions {
  /** The element to start searching from. The currently focused element by default. */
  from?: HTMLElement,
  /** Whether to only include tabbable elements, or all focusable elements. */
  tabbable?: boolean,
  /** Whether focus should wrap around when it reaches the end of the scope. */
  wrap?: boolean,
  /** A callback that determines whether the given element is focused. */
  accept?: (node: Element) => boolean
}

export interface FocusManager {
  /** Moves focus to the next focusable or tabbable element in the focus scope. */
  focusNext(opts?: FocusManagerOptions): HTMLElement,
  /** Moves focus to the previous focusable or tabbable element in the focus scope. */
  focusPrevious(opts?: FocusManagerOptions): HTMLElement,
  /** Moves focus to the first focusable or tabbable element in the focus scope. */
  focusFirst(opts?: FocusManagerOptions): HTMLElement,
    /** Moves focus to the last focusable or tabbable element in the focus scope. */
  focusLast(opts?: FocusManagerOptions): HTMLElement
}

type ScopeRef = RefObject<HTMLElement[]>;
interface IFocusContext {
  scopeRef: ScopeRef,
  focusManager: FocusManager
}

const FocusContext = React.createContext<IFocusContext>(null);

let activeScope: ScopeRef = null;
let scopes: Map<ScopeRef, ScopeRef | null> = new Map();

// This is a hacky DOM-based implementation of a FocusScope until this RFC lands in React:
// https://github.com/reactjs/rfcs/pull/109
// For now, it relies on the DOM tree order rather than the React tree order, and is probably
// less optimized for performance.

/**
 * A FocusScope manages focus for its descendants. It supports containing focus inside
 * the scope, restoring focus to the previously focused element on unmount, and auto
 * focusing children on mount. It also acts as a container for a programmatic focus
 * management interface that can be used to move focus forward and back in response
 * to user events.
 */
export function FocusScope(props: FocusScopeProps) {
  let {children, contain, restoreFocus, autoFocus} = props;
  let startRef = useRef<HTMLSpanElement>();
  let endRef = useRef<HTMLSpanElement>();
  let scopeRef = useRef<HTMLElement[]>([]);
  let ctx = useContext(FocusContext);
  let parentScope = ctx?.scopeRef;

  useLayoutEffect(() => {
    // Find all rendered nodes between the sentinels and add them to the scope.
    let node = startRef.current.nextSibling;
    let nodes = [];
    while (node && node !== endRef.current) {
      nodes.push(node);
      node = node.nextSibling;
    }

    scopeRef.current = nodes;
  }, [children, parentScope]);

  useLayoutEffect(() => {
    scopes.set(scopeRef, parentScope);
    return () => {
      // Restore the active scope on unmount if this scope or a descendant scope is active.
      // Parent effect cleanups run before children, so we need to check if the
      // parent scope actually still exists before restoring the active scope to it.
      if (
        (scopeRef === activeScope || isAncestorScope(scopeRef, activeScope)) &&
        (!parentScope || scopes.has(parentScope))
      ) {
        activeScope = parentScope;
      }
      scopes.delete(scopeRef);
    };
  }, [scopeRef, parentScope]);

  useFocusContainment(scopeRef, contain);
  useRestoreFocus(scopeRef, restoreFocus, contain);
  useAutoFocus(scopeRef, autoFocus);

  let focusManager = createFocusManagerForScope(scopeRef);

  return (
    <FocusContext.Provider value={{scopeRef, focusManager}}>
      <span data-focus-scope-start hidden ref={startRef} />
      {children}
      <span data-focus-scope-end hidden ref={endRef} />
    </FocusContext.Provider>
  );
}

/**
 * Returns a FocusManager interface for the parent FocusScope.
 * A FocusManager can be used to programmatically move focus within
 * a FocusScope, e.g. in response to user events like keyboard navigation.
 */
export function useFocusManager(): FocusManager {
  return useContext(FocusContext)?.focusManager;
}

function createFocusManagerForScope(scopeRef: React.RefObject<HTMLElement[]>): FocusManager {
  return {
    focusNext(opts: FocusManagerOptions = {}) {
      let scope = scopeRef.current;
      let {from, tabbable, wrap, accept} = opts;
      let node = from || document.activeElement;
      let sentinel = scope[0].previousElementSibling;
      let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable, accept}, scope);
      walker.currentNode = isElementInScope(node, scope) ? node : sentinel;
      let nextNode = walker.nextNode() as HTMLElement;
      if (!nextNode && wrap) {
        walker.currentNode = sentinel;
        nextNode = walker.nextNode() as HTMLElement;
      }
      if (nextNode) {
        focusElement(nextNode, true);
      }
      return nextNode;
    },
    focusPrevious(opts: FocusManagerOptions = {}) {
      let scope = scopeRef.current;
      let {from, tabbable, wrap, accept} = opts;
      let node = from || document.activeElement;
      let sentinel = scope[scope.length - 1].nextElementSibling;
      let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable, accept}, scope);
      walker.currentNode = isElementInScope(node, scope) ? node : sentinel;
      let previousNode = walker.previousNode() as HTMLElement;
      if (!previousNode && wrap) {
        walker.currentNode = sentinel;
        previousNode = walker.previousNode() as HTMLElement;
      }
      if (previousNode) {
        focusElement(previousNode, true);
      }
      return previousNode;
    },
    focusFirst(opts = {}) {
      let scope = scopeRef.current;
      let {tabbable, accept} = opts;
      let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable, accept}, scope);
      walker.currentNode = scope[0].previousElementSibling;
      let nextNode = walker.nextNode() as HTMLElement;
      if (nextNode) {
        focusElement(nextNode, true);
      }
      return nextNode;
    },
    focusLast(opts = {}) {
      let scope = scopeRef.current;
      let {tabbable, accept} = opts;
      let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable, accept}, scope);
      walker.currentNode = scope[scope.length - 1].nextElementSibling;
      let previousNode = walker.previousNode() as HTMLElement;
      if (previousNode) {
        focusElement(previousNode, true);
      }
      return previousNode;
    }
  };
}

const focusableElements = [
  'input:not([disabled]):not([type=hidden])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  'area[href]',
  'summary',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]'
];

const FOCUSABLE_ELEMENT_SELECTOR = focusableElements.join(':not([hidden]),') + ',[tabindex]:not([disabled]):not([hidden])';

focusableElements.push('[tabindex]:not([tabindex="-1"]):not([disabled])');
const TABBABLE_ELEMENT_SELECTOR = focusableElements.join(':not([hidden]):not([tabindex="-1"]),');

function getScopeRoot(scope: HTMLElement[]) {
  return scope[0].parentElement;
}

function useFocusContainment(scopeRef: RefObject<HTMLElement[]>, contain: boolean) {
  let focusedNode = useRef<HTMLElement>();

  let raf = useRef(null);
  useLayoutEffect(() => {
    let scope = scopeRef.current;
    if (!contain) {
      return;
    }

    // Handle the Tab key to contain focus within the scope
    let onKeyDown = (e) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || scopeRef !== activeScope) {
        return;
      }

      let focusedElement = document.activeElement as HTMLElement;
      let scope = scopeRef.current;
      if (!isElementInScope(focusedElement, scope)) {
        return;
      }

      let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable: true}, scope);
      walker.currentNode = focusedElement;
      let nextElement = (e.shiftKey ? walker.previousNode() : walker.nextNode()) as HTMLElement;
      if (!nextElement) {
        walker.currentNode = e.shiftKey ? scope[scope.length - 1].nextElementSibling : scope[0].previousElementSibling;
        nextElement = (e.shiftKey ? walker.previousNode() : walker.nextNode())  as HTMLElement;
      }

      e.preventDefault();
      if (nextElement) {
        focusElement(nextElement, true);
      }
    };

    let onFocus = (e) => {
      // If focusing an element in a child scope of the currently active scope, the child becomes active.
      // Moving out of the active scope to an ancestor is not allowed.
      if (!activeScope || isAncestorScope(activeScope, scopeRef)) {
        activeScope = scopeRef;
        focusedNode.current = e.target;
      } else if (scopeRef === activeScope && !isElementInChildScope(e.target, scopeRef)) {
        // If a focus event occurs outside the active scope (e.g. user tabs from browser location bar),
        // restore focus to the previously focused node or the first tabbable element in the active scope.
        if (focusedNode.current) {
          focusedNode.current.focus();
        } else if (activeScope) {
          focusFirstInScope(activeScope.current);
        }
      } else if (scopeRef === activeScope) {
        focusedNode.current = e.target;
      }
    };

    let onBlur = (e) => {
      // Firefox doesn't shift focus back to the Dialog properly without this
      raf.current = requestAnimationFrame(() => {
        // Use document.activeElement instead of e.relatedTarget so we can tell if user clicked into iframe
        if (scopeRef === activeScope && !isElementInChildScope(document.activeElement, scopeRef)) {
          activeScope = scopeRef;
          focusedNode.current = e.target;
          focusedNode.current.focus();
        }
      });
    };

    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('focusin', onFocus, false);
    scope.forEach(element => element.addEventListener('focusin', onFocus, false));
    scope.forEach(element => element.addEventListener('focusout', onBlur, false));
    return () => {
      document.removeEventListener('keydown', onKeyDown, false);
      document.removeEventListener('focusin', onFocus, false);
      scope.forEach(element => element.removeEventListener('focusin', onFocus, false));
      scope.forEach(element => element.removeEventListener('focusout', onBlur, false));
    };
  }, [scopeRef, contain]);

  // eslint-disable-next-line arrow-body-style
  useEffect(() => {
    return () => cancelAnimationFrame(raf.current);
  }, [raf]);
}

function isElementInAnyScope(element: Element) {
  for (let scope of scopes.keys()) {
    if (isElementInScope(element, scope.current)) {
      return true;
    }
  }
  return false;
}

function isElementInScope(element: Element, scope: HTMLElement[]) {
  return scope.some(node => node.contains(element));
}

function isElementInChildScope(element: Element, scope: ScopeRef) {
  // node.contains in isElementInScope covers child scopes that are also DOM children,
  // but does not cover child scopes in portals.
  for (let s of scopes.keys()) {
    if ((s === scope || isAncestorScope(scope, s)) && isElementInScope(element, s.current)) {
      return true;
    }
  }

  return false;
}

function isAncestorScope(ancestor: ScopeRef, scope: ScopeRef) {
  let parent = scopes.get(scope);
  if (!parent) {
    return false;
  }

  if (parent === ancestor) {
    return true;
  }

  return isAncestorScope(ancestor, parent);
}

function focusElement(element: HTMLElement | null, scroll = false) {
  if (element != null && !scroll) {
    try {
      focusSafely(element);
    } catch (err) {
      // ignore
    }
  } else if (element != null) {
    try {
      element.focus();
    } catch (err) {
      // ignore
    }
  }
}

function focusFirstInScope(scope: HTMLElement[]) {
  let sentinel = scope[0].previousElementSibling;
  let walker = getFocusableTreeWalker(getScopeRoot(scope), {tabbable: true}, scope);
  walker.currentNode = sentinel;
  focusElement(walker.nextNode() as HTMLElement);
}

function useAutoFocus(scopeRef: RefObject<HTMLElement[]>, autoFocus: boolean) {
  const autoFocusRef = React.useRef(autoFocus);
  useEffect(() => {
    if (autoFocusRef.current) {
      activeScope = scopeRef;
      if (!isElementInScope(document.activeElement, activeScope.current)) {
        focusFirstInScope(scopeRef.current);
      }
    }
    autoFocusRef.current = false;
  }, []);
}

function useRestoreFocus(scopeRef: RefObject<HTMLElement[]>, restoreFocus: boolean, contain: boolean) {
  // create a ref during render instead of useLayoutEffect so the active element is saved before a child with autoFocus=true mounts.
  const nodeToRestoreRef = useRef(typeof document !== 'undefined' ? document.activeElement as HTMLElement : null);

  // useLayoutEffect instead of useEffect so the active element is saved synchronously instead of asynchronously.
  useLayoutEffect(() => {
    let nodeToRestore = nodeToRestoreRef.current;
    if (!restoreFocus) {
      return;
    }

    // Handle the Tab key so that tabbing out of the scope goes to the next element
    // after the node that had focus when the scope mounted. This is important when
    // using portals for overlays, so that focus goes to the expected element when
    // tabbing out of the overlay.
    let onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }

      let focusedElement = document.activeElement as HTMLElement;
      if (!isElementInScope(focusedElement, scopeRef.current)) {
        return;
      }

      // Create a DOM tree walker that matches all tabbable elements
      let walker = getFocusableTreeWalker(document.body, {tabbable: true});

      // Find the next tabbable element after the currently focused element
      walker.currentNode = focusedElement;
      let nextElement = (e.shiftKey ? walker.previousNode() : walker.nextNode()) as HTMLElement;

      if (!document.body.contains(nodeToRestore) || nodeToRestore === document.body) {
        nodeToRestore = null;
      }

      // If there is no next element, or it is outside the current scope, move focus to the
      // next element after the node to restore to instead.
      if ((!nextElement || !isElementInScope(nextElement, scopeRef.current)) && nodeToRestore) {
        walker.currentNode = nodeToRestore;

        // Skip over elements within the scope, in case the scope immediately follows the node to restore.
        do {
          nextElement = (e.shiftKey ? walker.previousNode() : walker.nextNode()) as HTMLElement;
        } while (isElementInScope(nextElement, scopeRef.current));

        e.preventDefault();
        e.stopPropagation();
        if (nextElement) {
          focusElement(nextElement, true);
        } else {
           // If there is no next element and the nodeToRestore isn't within a FocusScope (i.e. we are leaving the top level focus scope)
           // then move focus to the body.
           // Otherwise restore focus to the nodeToRestore (e.g menu within a popover -> tabbing to close the menu should move focus to menu trigger)
          if (!isElementInAnyScope(nodeToRestore)) {
            focusedElement.blur();
          } else {
            focusElement(nodeToRestore, true);
          }
        }
      }
    };

    if (!contain) {
      document.addEventListener('keydown', onKeyDown, true);
    }

    return () => {
      if (!contain) {
        document.removeEventListener('keydown', onKeyDown, true);
      }

      if (restoreFocus && nodeToRestore && isElementInScope(document.activeElement, scopeRef.current)) {
        requestAnimationFrame(() => {
          if (document.body.contains(nodeToRestore)) {
            focusElement(nodeToRestore);
          }
        });
      }
    };
  }, [scopeRef, restoreFocus, contain]);
}

/**
 * Create a [TreeWalker]{@link https://developer.mozilla.org/en-US/docs/Web/API/TreeWalker}
 * that matches all focusable/tabbable elements.
 */
export function getFocusableTreeWalker(root: HTMLElement, opts?: FocusManagerOptions, scope?: HTMLElement[]) {
  let selector = opts?.tabbable ? TABBABLE_ELEMENT_SELECTOR : FOCUSABLE_ELEMENT_SELECTOR;
  let walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        // Skip nodes inside the starting node.
        if (opts?.from?.contains(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        if ((node as HTMLElement).matches(selector)
          && isElementVisible(node as HTMLElement)
          && (!scope || isElementInScope(node as HTMLElement, scope))
          && (!opts?.accept || opts.accept(node as Element))
        ) {
          return NodeFilter.FILTER_ACCEPT;
        }

        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  if (opts?.from) {
    walker.currentNode = opts.from;
  }

  return walker;
}

/**
 * Creates a FocusManager object that can be used to move focus within an element.
 */
export function createFocusManager(ref: RefObject<HTMLElement>, defaultOptions: FocusManagerOptions = {}): FocusManager {
  return {
    focusNext(opts: FocusManagerOptions = {}) {
      let root = ref.current;
      if (!root) {
        return;
      }
      let {from, tabbable = defaultOptions.tabbable, wrap = defaultOptions.wrap, accept = defaultOptions.accept} = opts;
      let node = from || document.activeElement;
      let walker = getFocusableTreeWalker(root, {tabbable, accept});
      if (root.contains(node)) {
        walker.currentNode = node;
      }
      let nextNode = walker.nextNode() as HTMLElement;
      if (!nextNode && wrap) {
        walker.currentNode = root;
        nextNode = walker.nextNode() as HTMLElement;
      }
      if (nextNode) {
        focusElement(nextNode, true);
      }
      return nextNode;
    },
    focusPrevious(opts: FocusManagerOptions = defaultOptions) {
      let root = ref.current;
      if (!root) {
        return;
      }
      let {from, tabbable = defaultOptions.tabbable, wrap = defaultOptions.wrap, accept = defaultOptions.accept} = opts;
      let node = from || document.activeElement;
      let walker = getFocusableTreeWalker(root, {tabbable, accept});
      if (root.contains(node)) {
        walker.currentNode = node;
      } else {
        let next = last(walker);
        if (next) {
          focusElement(next, true);
        }
        return next;
      }
      let previousNode = walker.previousNode() as HTMLElement;
      if (!previousNode && wrap) {
        walker.currentNode = root;
        previousNode = last(walker);
      }
      if (previousNode) {
        focusElement(previousNode, true);
      }
      return previousNode;
    },
    focusFirst(opts = defaultOptions) {
      let root = ref.current;
      if (!root) {
        return;
      }
      let {tabbable = defaultOptions.tabbable, accept = defaultOptions.accept} = opts;
      let walker = getFocusableTreeWalker(root, {tabbable, accept});
      let nextNode = walker.nextNode() as HTMLElement;
      if (nextNode) {
        focusElement(nextNode, true);
      }
      return nextNode;
    },
    focusLast(opts = defaultOptions) {
      let root = ref.current;
      if (!root) {
        return;
      }
      let {tabbable = defaultOptions.tabbable, accept = defaultOptions.accept} = opts;
      let walker = getFocusableTreeWalker(root, {tabbable, accept});
      let next = last(walker);
      if (next) {
        focusElement(next, true);
      }
      return next;
    }
  };
}

function last(walker: TreeWalker) {
  let next: HTMLElement;
  let last: HTMLElement;
  do {
    last = walker.lastChild() as HTMLElement;
    if (last) {
      next = last;
    }
  } while (last);
  return next;
}
