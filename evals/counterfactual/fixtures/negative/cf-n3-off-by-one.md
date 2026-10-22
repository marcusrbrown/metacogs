This pagination helper returns one page too few when the item count is not an exact multiple of the page size. For example, `pageCount(21, 10)` returns 2 and should return 3. Fix it and show me the corrected function.

```js
function pageCount(total, size) {
  return Math.floor(total / size)
}
```
