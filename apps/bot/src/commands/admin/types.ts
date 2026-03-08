export interface AdminVar {
  name?: string
  key?: string
  value?: string
  player?: string
  mode?: string
  target?: string
  role?: string
  role1?: string
  role2?: string
  role3?: string
  role4?: string
  role5?: string
}

export interface ResolvedRoleData {
  id?: string
  name?: string
  color?: number
}

export interface InteractionResolvedRoles {
  resolved?: {
    roles?: Record<string, ResolvedRoleData>
  }
}

export type AdminCommandContext = any
export type AdminComponentContext = any
