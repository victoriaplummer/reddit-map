const bus = new EventTarget();

export default {
  on(event, fn)   { bus.addEventListener(event, fn); },
  off(event, fn)  { bus.removeEventListener(event, fn); },
  fire(event, detail) { bus.dispatchEvent(new CustomEvent(event, { detail })); }
};
