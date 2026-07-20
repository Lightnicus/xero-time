---
name: react-useeffect-guide
description: Guide for writing correct, efficient, and idiomatic useEffect code in React. Use when writing, reviewing, or refactoring any code that uses or should use useEffect. Triggers on useEffect, cleanup functions, dependency arrays, data fetching in Effects, useLayoutEffect, or when synchronizing with external systems.
---

# React useEffect Best Practices

## Overview

`useEffect` exists to synchronize a component with an external system — anything outside React's control. This skill provides comprehensive guidance for writing correct, efficient, and idiomatic useEffect code.

**Golden Rule**: If there is no external system involved, you probably do not need an Effect.

## Quick Decision Checklist

Before writing `useEffect`, ask:

1. **Can I derive this value during render?** → Calculate inline or use `useMemo`
2. **Does this run because of a user interaction?** → Move to event handler
3. **Am I syncing state between sibling/parent?** → Lift state up or use `key`
4. **Am I subscribing to a React-external store?** → Use `useSyncExternalStore`
5. **Am I only using this Effect pattern in one place?** → If not, extract a custom hook
6. **Does my cleanup perfectly mirror my setup?** → Verify symmetry
7. **Are all reactive values in the dependency array?** → Never suppress linter warnings
8. **Am I fetching data?** → Add `ignore` guard; prefer a library or framework

## Common Anti-Patterns

### Deriving Data from State/Props
```js
// ❌ BAD: unnecessary Effect + state
const [fullName, setFullName] = useState('');
useEffect(() => { setFullName(firstName + ' ' + lastName); }, [firstName, lastName]);

// ✅ GOOD: compute during render
const fullName = firstName + ' ' + lastName;
```

### User Event Logic
```js
// ❌ BAD: notification in Effect
useEffect(() => {
  if (product.isInCart) showNotification(`Added ${product.name}!`);
}, [product]);

// ✅ GOOD: in the event handler
function handleBuyClick() {
  addToCart(product);
  showNotification(`Added ${product.name}!`);
}
```

### Resetting State on Prop Change
```js
// ❌ BAD: Effect to reset state
useEffect(() => { setComment(''); }, [userId]);

// ✅ GOOD: pass key to force remount
<Profile key={userId} userId={userId} />
```

## Correct Structure

```js
useEffect(() => {
  // SETUP: connect to / start the external system
  const connection = createConnection(serverUrl, roomId);
  connection.connect();

  // CLEANUP: must mirror and undo the setup
  return () => {
    connection.disconnect();
  };
}, [serverUrl, roomId]); // DEPENDENCIES: every reactive value used inside
```

## Dependency Rules

- Every reactive value used inside the Effect (props, state, variables/functions declared in the component) **must** be listed
- Never suppress the linter (`// eslint-disable-next-line react-hooks/exhaustive-deps`) — fix the root cause instead
- You cannot "choose" your dependencies — they are determined by the code inside the Effect

## Data Fetching

Always add a cleanup that prevents stale responses (race conditions):

```js
useEffect(() => {
  let ignore = false;

  async function fetchData() {
    const result = await fetchBio(person);
    if (!ignore) setBio(result); // discard if superseded
  }
  fetchData();

  return () => { ignore = true; };
}, [person]);
```

**Prefer better alternatives:**
1. Framework built-in fetching (Next.js, Remix, etc.) — most efficient
2. Data-fetching libraries: TanStack Query, SWR, React Router 6.4+
3. Custom hooks wrapping the fetch pattern above

## useEffect vs useLayoutEffect

Use `useLayoutEffect` instead of `useEffect` **only** when:
- The Effect reads or writes the DOM visually (e.g., measuring and positioning a tooltip)
- A flicker is noticeable because the browser paints before the Effect runs

For the vast majority of cases, `useEffect` is correct.

## Complete Reference

For detailed guidance on all patterns, see [references/useeffect-patterns.md](references/useeffect-patterns.md):

- All 9+ anti-patterns with solutions
- Removing unnecessary dependencies
- Cleanup best practices
- Custom hooks patterns
- Server rendering considerations

## Sources

- [React Docs: useEffect Reference](https://react.dev/reference/react/useEffect)
- [React Docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
