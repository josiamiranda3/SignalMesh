import {
  Activity,
  BadgeCheck,
  CircleDashed,
  FlaskConical,
  LayoutDashboard,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Sidebar navigation model.
 *
 * `primary` is the working surface; `secondary` groups the review surfaces
 * (validation, history) and configuration. Counts are injected by the layout so
 * the badges reflect persisted data rather than static labels.
 */
export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  badgeKey?: 'pendingReview'
  description: string
}

export const PRIMARY_NAV: NavItem[] = [
  {
    to: '/dashboard',
    label: 'Visão geral',
    icon: LayoutDashboard,
    end: true,
    description: 'Indicadores agregados da sua operação de pesquisa',
  },
  {
    to: '/investigations',
    label: 'Investigações',
    icon: FlaskConical,
    description: 'Todos os seus espaços de pesquisa',
  },
  {
    to: '/validation',
    label: 'Validação',
    icon: BadgeCheck,
    badgeKey: 'pendingReview',
    description: 'Fila de evidências aguardando decisão humana',
  },
  {
    to: '/history',
    label: 'Histórico',
    icon: Activity,
    description: 'Trilha de auditoria completa',
  },
]

export const SECONDARY_NAV: NavItem[] = [
  {
    to: '/settings',
    label: 'Configurações',
    icon: Settings,
    description: 'Provedores, limites de consumo e conta',
  },
]

export const ICONS = {
  Sparkles,
  CircleDashed,
}
