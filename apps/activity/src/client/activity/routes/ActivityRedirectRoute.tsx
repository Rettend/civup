import { useNavigate } from '@solidjs/router'
import { onSettled } from 'solid-js'
import { ActivityRedirectingPage } from '../activity-context'

export default function ActivityRedirectRoute() {
  const navigate = useNavigate()
  onSettled(() => navigate('/overview', { replace: true, scroll: false }))
  return <ActivityRedirectingPage />
}
