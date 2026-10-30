import { withoutBase } from 'ufo'

/** Nitro request hooks run before the application's router strips its base. */
export function getApplicationRequestPath(path: string, applicationBase: unknown): string {
  return withoutBase(path, typeof applicationBase === 'string' ? applicationBase : '/')
}
