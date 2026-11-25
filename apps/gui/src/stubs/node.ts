// Empty stand-ins for the Node modules the app never calls (see vite.config.ts).
const unavailable = () => {
  throw new Error('This is only available in Node')
}
export const mkdir = unavailable
export const readFile = unavailable
export const writeFile = unavailable
export const rename = unavailable
export const join = unavailable
export const dirname = unavailable
