import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { SubjectForm } from './SubjectForm'

describe('SubjectForm', () => {
  it('asks for a name and does not submit when it is blank', async () => {
    const onSubmit = vi.fn()
    render(<SubjectForm className="Primary 4" onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    expect(screen.getByText('Enter a subject name.')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the trimmed name and code', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<SubjectForm className="Primary 4" onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.type(screen.getByLabelText('Subject name'), '  Mathematics  ')
    await userEvent.type(screen.getByLabelText('Code (optional)'), ' math ')
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Mathematics', code: 'math' })
  })

  it('shows the heading for the class when creating', () => {
    render(<SubjectForm className="Primary 4" onSubmit={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByRole('heading', { name: 'New subject for Primary 4' })).toBeInTheDocument()
    expect(screen.getByLabelText('Subject name')).toHaveValue('')
  })

  it('prefills the name and code when editing (a fresh form per subject, as the page mounts it)', () => {
    render(<SubjectForm className="Primary 4" initial={{ id: '1', classId: 'c', name: 'English', code: 'ENG', isActive: true }} onSubmit={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Edit English' })).toBeInTheDocument()
    expect(screen.getByLabelText('Subject name')).toHaveValue('English')
    expect(screen.getByLabelText('Code (optional)')).toHaveValue('ENG')
  })

  it('shows a server refusal (duplicate name) next to the field and as a message, and lets the user try again', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, 'duplicate_name', { error: 'duplicate_name', fields: { name: 'This class already has a subject with this name.' } }))
    render(<SubjectForm className="Primary 4" onSubmit={onSubmit} onCancel={() => {}} />)
    await userEvent.type(screen.getByLabelText('Subject name'), 'Maths')
    await userEvent.click(screen.getByRole('button', { name: 'Create subject' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This class already has a subject with this name.')
    expect(screen.getByRole('button', { name: 'Create subject' })).toBeEnabled()
  })

  it('calls onCancel', async () => {
    const onCancel = vi.fn()
    render(<SubjectForm className="Primary 4" onSubmit={vi.fn()} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})