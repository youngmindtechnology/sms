import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { SubjectsPage } from './SubjectsPage'

const h = vi.hoisted(() => ({ perms: new Set<string>() }))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }))
vi.mock('../features/classes/classesApi', () => ({ listClasses: vi.fn() }))
vi.mock('../features/calendar/calendarApi', () => ({ listYears: vi.fn() }))
vi.mock('../features/subjects/subjectsApi', () => ({
  listSubjects: vi.fn(), createSubject: vi.fn(), updateSubject: vi.fn(), listEligibleTeachers: vi.fn(),
  assignTeacher: vi.fn(), replaceTeacher: vi.fn(), endAssignment: vi.fn(),
}))

import { listYears } from '../features/calendar/calendarApi'
import { listClasses } from '../features/classes/classesApi'
import * as api from '../features/subjects/subjectsApi'

const p4 = { id: 'c4', name: 'Primary 4', level: 'PRIMARY', sortOrder: 1, isActive: true }
const year = { id: 'y1', name: '2026/2027', startDate: '2026-09-01', endDate: '2027-07-31', status: 'ACTIVE' }
const closed = { id: 'y0', name: '2025/2026', startDate: '2025-09-01', endDate: '2026-07-31', status: 'CLOSED' }
const assignment = { id: 'a1', subjectId: 's1', academicYearId: 'y1', academicYearName: '2026/2027', teacherMembershipId: 'm1', teacherName: 'Ama Mensah', status: 'ACTIVE', endedAt: null, createdAt: '2026-10-01T00:00:00.000Z' }
const maths = { id: 's1', classId: 'c4', name: 'Mathematics', code: 'MATH', isActive: true, teachers: [assignment] }
const english = { id: 's2', classId: 'c4', name: 'English', code: null, isActive: true, teachers: [] }
const payload = (subjects: unknown[]) => ({ class: { id: 'c4', name: 'Primary 4', isActive: true }, academicYear: { id: 'y1', name: '2026/2027', status: 'ACTIVE' }, subjects })

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  h.perms = new Set(['academics:read', 'subjects:manage', 'subjects:assign'])
  mocked(listClasses).mockResolvedValue([p4])
  mocked(listYears).mockResolvedValue([closed, year])
  mocked(api.listSubjects).mockResolvedValue(payload([maths, english]))
  mocked(api.listEligibleTeachers).mockResolvedValue([{ membershipId: 'm1', fullName: 'Ama Mensah' }, { membershipId: 'm2', fullName: 'Kofi Boateng' }])
})

describe('SubjectsPage', () => {
  it('shows a loading message, then the subjects of the first class for the current year', async () => {
    render(<SubjectsPage />)
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
    expect(await screen.findByText('Mathematics')).toBeInTheDocument()
    expect(api.listSubjects).toHaveBeenCalledWith('c4', 'y1', expect.anything())
    expect(screen.getByLabelText('Academic year')).toHaveValue('y1')
    expect(screen.getByText('No teacher assigned')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('Ama Mensah')).toBeInTheDocument()
  })

  it('shows an empty state when the class has no subjects', async () => {
    mocked(api.listSubjects).mockResolvedValue(payload([]))
    render(<SubjectsPage />)
    expect(await screen.findByText('No subjects in Primary 4 yet')).toBeInTheDocument()
  })

  it('shows a clear message when classes are missing', async () => {
    mocked(listClasses).mockResolvedValue([])
    render(<SubjectsPage />)
    expect(await screen.findByText('No classes yet')).toBeInTheDocument()
  })

  it('shows an error and a retry button when the subjects cannot be loaded', async () => {
    mocked(api.listSubjects).mockRejectedValueOnce(new ApiError(500, 'internal_error')).mockResolvedValue(payload([maths]))
    render(<SubjectsPage />)
    expect(await screen.findByText("The subjects couldn't be loaded.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Mathematics')).toBeInTheDocument()
  })

  it('shows an error when classes and years cannot be loaded', async () => {
    mocked(listYears).mockRejectedValue(new ApiError(500, 'internal_error'))
    render(<SubjectsPage />)
    expect(await screen.findByText("Classes and academic years couldn't be loaded.")).toBeInTheDocument()
  })

  it('tells people without academics:read that they have no access, and calls no API', () => {
    h.perms = new Set()
    render(<SubjectsPage />)
    expect(screen.getByText("You can't view subjects")).toBeInTheDocument()
    expect(listClasses).not.toHaveBeenCalled()
    expect(api.listSubjects).not.toHaveBeenCalled()
  })

  it('is view-only for a teacher: sees subjects and teachers, every action is disabled or absent, no candidate list is requested', async () => {
    h.perms = new Set(['academics:read'])
    render(<SubjectsPage />)
    expect(await screen.findByText('Mathematics')).toBeInTheDocument()
    expect(screen.getByText('You have view-only access to subjects.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New subject' })[0]).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit Mathematics' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deactivate Mathematics' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Assign a teacher to Mathematics' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^Replace/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^End/ })).not.toBeInTheDocument()
    expect(api.listEligibleTeachers).not.toHaveBeenCalled()
  })

  it('lets a subject manager who cannot assign create subjects but not assign teachers', async () => {
    h.perms = new Set(['academics:read', 'subjects:manage'])
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    expect(screen.getByRole('button', { name: 'Edit Mathematics' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Assign a teacher to English' })).toBeDisabled()
  })

  it('creates a subject: validates, sends the class and values, shows a success message and reloads', async () => {
    mocked(api.createSubject).mockResolvedValue({ id: 's3', classId: 'c4', name: 'Science', code: 'SCI', isActive: true })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await userEvent.click(screen.getAllByRole('button', { name: 'New subject' })[0]!)
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    expect(screen.getByText('Enter a subject name.')).toBeInTheDocument()
    expect(api.createSubject).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Subject name'), 'Science')
    await userEvent.type(screen.getByLabelText('Code (optional)'), 'SCI')
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    await waitFor(() => expect(api.createSubject).toHaveBeenCalledWith('c4', { name: 'Science', code: 'SCI' }))
    expect(await screen.findByText('Subject created.')).toBeInTheDocument()
    expect(api.listSubjects).toHaveBeenCalledTimes(2)
  })

  it('shows the server message when a duplicate subject is refused', async () => {
    mocked(api.createSubject).mockRejectedValue(new ApiError(409, 'duplicate_name', { error: 'duplicate_name', fields: { name: 'This class already has a subject with this name.' } }))
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await userEvent.click(screen.getAllByRole('button', { name: 'New subject' })[0]!)
    await userEvent.type(screen.getByLabelText('Subject name'), 'Mathematics')
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    expect((await screen.findAllByText('This class already has a subject with this name.')).length).toBeGreaterThan(0)
  })

  it('assigns a teacher: only people not already on the subject are offered; the class year and subject are sent', async () => {
    mocked(api.assignTeacher).mockResolvedValue({ ...assignment, id: 'a2', subjectId: 's1', teacherMembershipId: 'm2', teacherName: 'Kofi Boateng' })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign a teacher to Mathematics' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Assign a teacher to Mathematics' }))
    const options = within(screen.getByLabelText('Teacher')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Choose a teacher', 'Kofi Boateng'])
    await userEvent.selectOptions(screen.getByLabelText('Teacher'), 'm2')
    await userEvent.click(screen.getByRole('button', { name: 'Assign teacher' }))
    await waitFor(() => expect(api.assignTeacher).toHaveBeenCalledWith('s1', 'y1', 'm2'))
    expect(await screen.findByText('Teacher assigned.')).toBeInTheDocument()
  })

  it('replaces a teacher and says the earlier assignment is kept', async () => {
    mocked(api.replaceTeacher).mockResolvedValue({ ended: { ...assignment, status: 'ENDED' }, created: { ...assignment, id: 'a2' } })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace Ama Mensah on Mathematics' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Replace Ama Mensah on Mathematics' }))
    await userEvent.selectOptions(screen.getByLabelText('Teacher'), 'm2')
    await userEvent.click(screen.getByRole('button', { name: 'Replace teacher' }))
    await waitFor(() => expect(api.replaceTeacher).toHaveBeenCalledWith('a1', 'm2'))
    expect(await screen.findByText(/earlier assignment is kept/i)).toBeInTheDocument()
  })

  it('asks for confirmation before ending an assignment, and does nothing if the user keeps it', async () => {
    mocked(api.endAssignment).mockResolvedValue({ ...assignment, status: 'ENDED' })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await userEvent.click(screen.getByRole('button', { name: "End Ama Mensah's assignment to Mathematics" }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent("End Ama Mensah's assignment to Mathematics?")
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(api.endAssignment).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: "End Ama Mensah's assignment to Mathematics" }))
    await userEvent.click(screen.getByRole('button', { name: 'End assignment' }))
    await waitFor(() => expect(api.endAssignment).toHaveBeenCalledWith('a1'))
    expect(await screen.findByText("Ama Mensah's assignment has ended.")).toBeInTheDocument()
  })

  it('asks for confirmation before deactivating a subject', async () => {
    mocked(api.updateSubject).mockResolvedValue({ ...maths, isActive: false })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate Mathematics' }))
    expect(api.updateSubject).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Deactivate Mathematics?')
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(api.updateSubject).toHaveBeenCalledWith('s1', { isActive: false }))
  })

  it('in a closed year it explains the limit and does not allow assigning', async () => {
    mocked(api.listSubjects).mockResolvedValue({ ...payload([maths]), academicYear: { id: 'y0', name: '2025/2026', status: 'CLOSED' } })
    render(<SubjectsPage />)
    await screen.findByText('Mathematics')
    await userEvent.selectOptions(screen.getByLabelText('Academic year'), 'y0')
    expect(await screen.findByText(/This academic year is closed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign a teacher to Mathematics' })).toBeDisabled()
    expect(screen.getByRole('button', { name: "End Ama Mensah's assignment to Mathematics" })).toBeEnabled()
  })

  it('shows a safe message when the server says the teacher is no longer eligible, without leaving the form', async () => {
    mocked(api.assignTeacher).mockRejectedValue(new ApiError(409, 'teacher_not_eligible', { error: 'teacher_not_eligible' }))
    render(<SubjectsPage />)
    await screen.findByText('English')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign a teacher to English' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Assign a teacher to English' }))
    await userEvent.selectOptions(screen.getByLabelText('Teacher'), 'm2')
    await userEvent.click(screen.getByRole('button', { name: 'Assign teacher' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only active teachers of your school can be assigned')
  })
})
