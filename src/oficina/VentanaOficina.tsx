import { useEffect, useState } from 'react';
import type { ProfileWithStatus } from '../../shared/types';
import Oficina from './Oficina';

/** La Oficina en vivo sola, en su ventana. Las cuentas las pide ella misma:
 *  no hay un panel detrás que se las pase. */
export default function VentanaOficina() {
  const [profiles, setProfiles] = useState<ProfileWithStatus[]>([]);
  useEffect(() => {
    document.title = 'Claude Monitor · Oficina en vivo';
    window.claudeMonitor.listProfiles().then((r) => r.ok && setProfiles(r.data.profiles));
  }, []);
  return <Oficina profiles={profiles} enVentana onClose={() => window.close()} />;
}
