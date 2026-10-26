import {
  BookOpen,
  CalendarDays,
  FileText,
  LayoutDashboard,
  School,
  Settings,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
  /** 'available' = built. 'planned' = routes to a labelled placeholder page. */
  status: 'available' | 'planned'
  description: string
}

/**
 * Single source of truth for navigation. The sidebar, the router and the
 * header title are all generated from this list, so adding a module means
 * editing one place.
 */
export const navItems: NavItem[] = [
  {
    path: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    status: 'available',
    description: 'Overview of enrollment, fees and recent activity.',
  },
  {
    path: '/calendar',
    label: 'Academic Calendar',
    icon: CalendarDays,
    status: 'available',
    description: 'Academic years and terms for your school.',
  },
  {
    path: '/students',
    label: 'Students',
    icon: Users,
    status: 'planned',
    description: 'Student registration, profiles and guardian details.',
  },
  {
    path: '/classes',
    label: 'Classes',
    icon: School,
    status: 'available',
    description: 'Class names, levels and order for your school.',
  },
  {
    path: '/academics',
    label: 'Academics',
    icon: BookOpen,
    status: 'planned',
    description: 'Subjects, assessments and score entry.',
  },
  {
    path: '/report-cards',
    label: 'Report Cards',
    icon: FileText,
    status: 'planned',
    description: 'Term grading and printable report cards.',
  },
  {
    path: '/fees',
    label: 'Fees & Payments',
    icon: Wallet,
    status: 'planned',
    description: 'Fee structures, invoices and payment records.',
  },
  {
    path: '/staff',
    label: 'Staff',
    icon: UserCog,
    status: 'planned',
    description: 'Teacher and staff records and assignments.',
  },
  {
    path: '/settings',
    label: 'School Settings',
    icon: Settings,
    status: 'planned',
    description: 'School profile, academic terms and preferences.',
  },
]

export function findNavItem(pathname: string): NavItem | undefined {
  return navItems.find((item) => item.path === pathname)
}
