export interface SchoolChoice {
  schoolId: string
  schoolName: string
  roles: string[]
}

export interface Me {
  user: { id: string; email: string; fullName: string }
  school: { id: string; name: string; roles: string[]; permissions: string[] } | null
  schools: SchoolChoice[]
  csrfToken: string
}
