import type { DashboardSample } from '../types/dashboard'

/**
 * DEVELOPMENT-ONLY SAMPLE DATA.
 * Every figure here is fictional. It does not come from, and is not
 * connected to, any real school, student or payment record.
 * No personal names are used on purpose.
 */
export const sampleDashboard: DashboardSample = {
  schoolName: 'Demo Basic School',
  termLabel: 'Term 1 (sample)',
  enrollment: [
    { level: 'Nursery', students: 38, classes: 2 },
    { level: 'Kindergarten', students: 64, classes: 2 },
    { level: 'Primary', students: 210, classes: 6 },
    { level: 'JHS', students: 96, classes: 3 },
  ],
  fees: {
    billed: 260000,
    collected: 184350,
  },
  recentActivity: [
    {
      id: 'a1',
      kind: 'Enrollment',
      description: 'New student record added to Primary 4',
      timeLabel: '2 hours ago',
    },
    {
      id: 'a2',
      kind: 'Payment',
      description: 'Term fee payment recorded for a Primary 6 student',
      timeLabel: '5 hours ago',
    },
    {
      id: 'a3',
      kind: 'Academics',
      description: 'Mid-term scores entered for JHS 2 Mathematics',
      timeLabel: 'Yesterday',
    },
    {
      id: 'a4',
      kind: 'Staff',
      description: 'Class teacher assigned to Kindergarten 1',
      timeLabel: 'Yesterday',
    },
    {
      id: 'a5',
      kind: 'Payment',
      description: 'Part payment recorded for a JHS 1 student',
      timeLabel: '2 days ago',
    },
  ],
}
