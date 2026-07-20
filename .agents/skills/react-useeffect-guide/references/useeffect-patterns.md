# React useEffect Patterns and Best Practices

Complete reference guide for useEffect patterns, anti-patterns, and solutions.

## Table of Contents

1. [What useEffect Is For](#1-what-useeffect-is-for)
2. [When NOT to Use useEffect](#2-when-not-to-use-useeffect)
   - [Deriving Data](#2a-deriving-data-from-stateprops)
   - [Expensive Calculations](#2b-expensive-calculations)
   - [Resetting State](#2c-resetting-state-on-prop-change)
   - [User Event Logic](#2d-user-event-logic)
   - [Chained State Updates](#2e-chained-state-updates)
   - [Notifying Parent](#2f-notifying-parent-of-state-change)
   - [Reverse Data Flow](#2g-passing-data-up-to-parent)
   - [External Store Subscriptions](#2h-subscribing-to-external-store)
   - [One-Time Initialization](#2i-one-time-app-initialization)
3. [Correct Structure](#3-correct-useeffect-structure)
4. [Dependencies](#4-dependencies)
5. [Data Fetching](#5-data-fetching-in-effects)
6. [Cleanup](#6-cleanup-best-practices)
7. [Custom Hooks](#7-encapsulate-in-custom-hooks)
8. [useLayoutEffect](#8-useeffect-vs-uselayouteffect)
9. [Server Rendering](#9-server-rendering)

---

## 1. What useEffect Is For

`useEffect` exists to **synchronize a component with an external system** — anything outside React's control:

- Network connections (WebSockets, chat servers)
- Browser APIs (`addEventListener`, `IntersectionObserver`, `setInterval`)
- Third-party libraries (maps, animation engines, jQuery widgets)
- Data fetching (as a fallback; prefer framework solutions)

**If there is no external system involved, you probably do not need an Effect.**

---

## 2. When NOT to Use useEffect

Before writing a `useEffect`, check whether the problem can be solved without one.

### 2a. Deriving Data from State/Props → Calculate During Render

```js
// ❌ BAD: unnecessary Effect + state
const [fullName, setFullName] = useState('');
useEffect(() => {
  setFullName(firstName + ' ' + lastName);
}, [firstName, lastName]);

// ✅ GOOD: compute during render
const fullName = firstName + ' ' + lastName;
```

### 2b. Expensive Calculations → useMemo

```js
// ❌ BAD
const [visibleTodos, setVisibleTodos] = useState([]);
useEffect(() => {
  setVisibleTodos(getFilteredTodos(todos, filter));
}, [todos, filter]);

// ✅ GOOD
const visibleTodos = useMemo(() => getFilteredTodos(todos, filter), [todos, filter]);
```

Use `useMemo` when `console.time` reveals a calculation takes ≥1ms.

### 2c. Resetting State on Prop Change → Use `key`

```js
// ❌ BAD: Effect to reset state
useEffect(() => { setComment(''); }, [userId]);

// ✅ GOOD: pass key to force remount
<Profile key={userId} userId={userId} />
```

### 2d. User Event Logic → Event Handlers

```js
// ❌ BAD: notification in Effect (fires on every render where isInCart is true)
useEffect(() => {
  if (product.isInCart) showNotification(`Added ${product.name}!`);
}, [product]);

// ✅ GOOD: in the event handler
function handleBuyClick() {
  addToCart(product);
  showNotification(`Added ${product.name}!`);
}
```

**Rule:** If code runs because the user did something, put it in an event handler. If it runs because the component appeared on screen, put it in an Effect.

### 2e. Chained State Updates → Single Event Handler

```js
// ❌ BAD: chain of Effects each triggering the next
useEffect(() => { if (card?.gold) setGoldCardCount(c => c + 1); }, [card]);
useEffect(() => { if (goldCardCount > 3) setRound(r => r + 1); }, [goldCardCount]);

// ✅ GOOD: all state updates in one event handler
function handlePlaceCard(nextCard) {
  setCard(nextCard);
  if (nextCard.gold) {
    if (goldCardCount < 3) setGoldCardCount(goldCardCount + 1);
    else { setGoldCardCount(0); setRound(round + 1); }
  }
}
```

### 2f. Notifying Parent of State Change → Update Both in the Same Event

```js
// ❌ BAD: Effect to call parent onChange
useEffect(() => { onChange(isOn); }, [isOn, onChange]);

// ✅ GOOD: call both in the event handler
function updateToggle(nextIsOn) {
  setIsOn(nextIsOn);
  onChange(nextIsOn);
}
```

### 2g. Passing Data Up to Parent → Reverse Data Flow Instead

```js
// ❌ BAD: child fetches then passes up via Effect
useEffect(() => { if (data) onFetched(data); }, [data, onFetched]);

// ✅ GOOD: parent fetches and passes down
function Parent() {
  const data = useSomeAPI();
  return <Child data={data} />;
}
```

### 2h. Subscribing to External Store → useSyncExternalStore

```js
// ✅ GOOD: purpose-built hook for external subscriptions
return useSyncExternalStore(
  subscribe,              // subscription function
  () => navigator.onLine, // client snapshot
  () => true              // server snapshot
);
```

### 2i. One-Time App Initialization → Module-Level or Guard Variable

```js
// ✅ GOOD option 1: module-level (runs once on import)
if (typeof window !== 'undefined') {
  checkAuthToken();
  loadDataFromLocalStorage();
}

// ✅ GOOD option 2: guard variable inside Effect
let didInit = false;
useEffect(() => {
  if (!didInit) {
    didInit = true;
    loadDataFromLocalStorage();
    checkAuthToken();
  }
}, []);
```

---

## 3. Correct useEffect Structure

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

**Lifecycle:**
1. Setup runs after the component mounts
2. On dependency change: cleanup runs with old values → setup runs with new values
3. Cleanup runs one final time when the component unmounts
4. In Strict Mode (development only): an extra setup → cleanup → setup cycle runs to expose bugs

---

## 4. Dependencies

### Rules

- Every reactive value used inside the Effect (props, state, variables/functions declared in the component) **must** be listed
- Never suppress the linter (`// eslint-disable-next-line react-hooks/exhaustive-deps`). Fix the root cause instead
- You cannot "choose" your dependencies — they are determined by the code inside the Effect

### Dependency Array Forms

| Form | Behavior |
|------|----------|
| `[a, b]` | Runs after mount and whenever `a` or `b` changes |
| `[]` | Runs only after the initial mount |
| *(omitted)* | Runs after every render — almost always wrong |

### Removing Unnecessary Dependencies

**Object dependency (recreated each render):** Move object creation inside the Effect.

```js
// ❌ options is new every render
useEffect(() => { connect(options); }, [options]);

// ✅ create it inside
useEffect(() => {
  const options = { serverUrl, roomId };
  connect(options);
}, [roomId]); // serverUrl is stable constant outside component
```

**Function dependency:** Move function declaration inside the Effect.

```js
// ❌ createOptions is new every render
useEffect(() => { connect(createOptions()); }, [createOptions]);

// ✅ define it inside
useEffect(() => {
  function createOptions() { return { serverUrl, roomId }; }
  connect(createOptions());
}, [roomId]);
```

**State updater to avoid depending on current state:**

```js
// ❌ count must be a dependency, resets interval every second
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, [count]);

// ✅ functional updater removes the dependency
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  return () => clearInterval(id);
}, []);
```

**Non-reactive logic inside Effect → useEffectEvent:**

```js
// Read latest shoppingCart without making it a dependency
const onVisit = useEffectEvent(visitedUrl => {
  logVisit(visitedUrl, shoppingCart.length); // shoppingCart always current
});
useEffect(() => {
  onVisit(url);
}, [url]); // only re-runs when url changes
```

---

## 5. Data Fetching in Effects

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

**Downsides of raw Effect fetching:**
- No server-side rendering support
- Easy to create network waterfalls
- No automatic caching or deduplication

---

## 6. Cleanup Best Practices

Cleanup must **mirror** setup — undo exactly what setup did:

| Setup | Cleanup |
|-------|---------|
| `connection.connect()` | `connection.disconnect()` |
| `window.addEventListener(type, fn)` | `window.removeEventListener(type, fn)` |
| `setInterval(fn, ms)` → `id` | `clearInterval(id)` |
| `observer.observe(el)` | `observer.disconnect()` |
| `animation.start()` | `animation.reset()` |
| `ignore = false` (fetch guard) | `ignore = true` |

Cleanup without matching setup is a code smell:

```js
// ❌ suspicious: cleanup with no setup
useEffect(() => {
  return () => doSomething();
}, []);
```

---

## 7. Encapsulate in Custom Hooks

When you use the same Effect pattern in multiple components, extract it:

```js
// Custom hook hides implementation details
function useChatRoom({ serverUrl, roomId }) {
  useEffect(() => {
    const connection = createConnection({ serverUrl, roomId });
    connection.connect();
    return () => connection.disconnect();
  }, [serverUrl, roomId]);
}

// Usage — clean and declarative
function ChatRoom({ roomId }) {
  useChatRoom({ roomId, serverUrl: 'https://localhost:1234' });
}
```

Good candidates for custom hooks: `useWindowListener`, `useIntersectionObserver`, `useOnlineStatus`, `useData`

---

## 8. useEffect vs useLayoutEffect

Use `useLayoutEffect` instead of `useEffect` **only** when:
- The Effect reads or writes the DOM visually (e.g., measuring and positioning a tooltip)
- A flicker is noticeable because the browser paints before the Effect runs

For the vast majority of cases, `useEffect` is correct.

---

## 9. Server Rendering

Effects **do not run on the server**. For content that differs between server and client (e.g., reading `localStorage`):

```js
const [didMount, setDidMount] = useState(false);
useEffect(() => { setDidMount(true); }, []);

if (didMount) { /* client-only content */ }
else { /* server-safe content */ }
```

Use this sparingly — users on slow connections will see the initial content for some time.

---

## Sources

- [React Docs: useEffect Reference](https://react.dev/reference/react/useEffect)
- [React Docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
