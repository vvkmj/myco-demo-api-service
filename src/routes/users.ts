/**
 * User routes for the API service.
 * Imports formatUser and UserRecord from the shared-utils package.
 *
 * If shared-utils renames or removes `formatUser` or `UserRecord`,
 * this file breaks at build time — Myco should catch it before merge.
 */
import { formatUser, UserRecord } from "@myco-demo/shared-utils";

export function handleGetUser(rawUser: UserRecord): string {
  // formatUser is the ONLY way we render a user — direct dependency.
  return formatUser(rawUser);
}

export function handleListUsers(users: UserRecord[]): string[] {
  return users.map(formatUser);
}
