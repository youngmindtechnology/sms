export interface SchoolChoice {
  schoolId: string
  schoolName: string
  roles: string[]
}

export interface Me {
  user: { id: string; email: string; fullName: string }
  school: { id: string; name: string; roles: string[]; permissions: string[] } | null
  schools: SchoolChoice[]
  /** True while the password is a temporary one: the person must choose their own before anything else. */
  mustChangePassword: boolean
  csrfToken: string
}
