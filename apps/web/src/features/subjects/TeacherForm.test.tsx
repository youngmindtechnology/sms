import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { TeacherForm } from './TeacherForm'

const teachers = [{ membershipId: 'm1', fullName: 'Ama Mensah' }, { membershipId: 'm2', fullName: 'Kofi Boateng' }]

describe('TeacherForm', () => {
  it('asks for a teacher and does not submit without one', async () => {
    const onSubmit = vi.fn()
    render(<TeacherForm title="Assign a teacher to Maths" submitLabel="Assign teacher" teachers={teachers} onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Assign teacher' }))
    expect(screen.getByText('Choose a teacher.')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the chosen membership id', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<TeacherForm title="Assign a teacher to Maths" submitLabel="Assign teacher" teachers={teachers} onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.selectOptions(screen.getByLabelText('Teacher'), 'm2')
    await userEvent.click(screen.getByRole('button', { name: 'Assign teacher' }))
    expect(onSubmit).toHaveBeenCalledWith('m2')
  })

  it('explains when nobody can be chosen and disables saving', () => {
    render(<TeacherForm title="Assign" submitLabel="Assign teacher" teachers={[]} onSubmit={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByText(/no other active teacher/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign teacher' })).toBeDisabled()
  })

  it('shows a safe message when the server refuses (teacher no longer eligible)', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, 'teacher_not_eligible', { error: 'teacher_not_eligible' }))
    render(<TeacherForm title="Assign" submitLabel="Assign teacher" teachers={teachers} onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.selectOptions(screen.getByLabelText('Teacher'), 'm1')
    await userEvent.click(screen.getByRole('button', { name: 'Assign teacher' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only active teachers of your school can be assigned')
  })
})
