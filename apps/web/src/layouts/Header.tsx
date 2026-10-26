import { LogOut, Menu } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { Button } from '../components/ui/Button'

interface HeaderProps {
  title: string
  sidebarOpen: boolean
  onMenuClick: () => void
}

export function Header({ title, sidebarOpen, onMenuClick }: HeaderProps) {
  const { me, logout } = useAuth()
  return (
    <header className="app-header">
      <Button
        variant="ghost"
        className="menu-toggle"
        aria-label="Open navigation"
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        onClick={onMenuClick}
      >
        <Menu size={20} aria-hidden="true" />
      </Button>

      <p className="app-header__title">{title}</p>

      <div className="header-user">
        <span className="header-user__text">
          <span>{me?.user.fullName}</span>
          <span className="header-user__role">
            {me?.school?.name} · {me?.school?.roles.map((r) => r.charAt(0) + r.slice(1).toLowerCase()).join(', ')}
          </span>
        </span>
        <Button variant="secondary" onClick={() => void logout()}>
          <LogOut size={16} aria-hidden="true" /> Sign out
        </Button>
      </div>
    </header>
  )
}
