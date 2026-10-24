In `src/users.ts`, rename the function `getUsr` to `getUser` everywhere in this snippet and reply with the updated code:

```ts
export function getUsr(id: string) {
  return db.users.find(id)
}

export const admin = getUsr('admin')
export const guest = getUsr('guest')
```
