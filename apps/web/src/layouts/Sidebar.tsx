import { X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { navItems } from '../app/navigation'
import { Button } from '../components/ui/Button'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside id="app-sidebar" className="sidebar" data-open={open}>
      <div className="sidebar__top">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            YMT
          </span>
          <span className="brand__text">
            <span className="brand__name">Young Mind Technology</span>
            <span className="brand__product">School Management</span>
          </span>
        </div>
        <Button
          variant="ghost"
          className="sidebar__close"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </Button>
      </div>

      <nav className="sidebar__nav" aria-label="Main navigation">
        <ul className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  onClick={onClose}
                  className={({ isActive }) =>
                    isActive ? 'nav-link nav-link--active' : 'nav-link'
                  }
                >
                  <Icon size={18} aria-hidden="true" />
                  <span className="nav-link__label">{item.label}</span>
                  {item.status === 'planned' ? (
                    <span className="nav-link__tag">Soon</span>
                  ) : null}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>

      <p className="sidebar__footer">Phase 1 development build</p>
    </aside>
  )
}
