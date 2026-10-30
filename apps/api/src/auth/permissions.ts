/**
 * Role -> permission map. Roles come from the database (school_membership_roles)
 * for ONE school at a time; a user's role in one school grants nothing in another.
 * Permissions for later phases are declared now so the vocabulary stays stable,
 * but no route uses them until its phase is built.
 */
export const SCHOOL_ROLES = ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

export const PERMISSIONS = [
  "school:read",
  "school:settings",
  "staff:manage",
  "students:read",
  "students:write",
  "students:sensitive",
  "academics:read",
  "academics:write",
  "calendar:manage",
  "classes:manage",
  "subjects:manage",
  "subjects:assign",
  "fees:read",
  "fees:manage",
  "payments:record",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const ROLE_PERMISSIONS: Record<SchoolRole, readonly Permission[]> = {
  OWNER: ALL,
  HEADTEACHER: ALL.filter((p) => p !== "staff:manage"),
  ADMINISTRATOR: [
    "school:read", "staff:manage", "students:read", "students:write", "students:sensitive", "academics:read", "academics:write", "calendar:manage", "classes:manage", "subjects:manage", "subjects:assign", "fees:read",
  ],
  TEACHER: ["school:read", "students:read", "academics:read", "academics:write"],
  BURSAR: ["school:read", "students:read", "fees:read", "fees:manage", "payments:record"],
};

export function permissionsFor(roles: readonly string[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    const list = ROLE_PERMISSIONS[role as SchoolRole];
    if (list) for (const permission of list) granted.add(permission);
  }
  return granted; // unknown role names grant nothing (deny by default)
}

export function can(roles: readonly string[], permission: Permission): boolean {
  return permissionsFor(roles).has(permission);
}
