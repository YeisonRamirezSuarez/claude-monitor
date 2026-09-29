# El estado de la tapa, para el modo fuera de Telegram (ver presencia.ts).
#
# Windows avisa los cambios de la tapa con un evento de energía
# (GUID_LIDSWITCH_STATE_CHANGE) que sólo llega a una ventana registrada con
# RegisterPowerSettingNotification. Electron no lo expone, así que esto crea
# una ventana oculta y escribe "lid 0" (cerrada) o "lid 1" (abierta) por stdout.
# Windows manda el estado actual apenas se registra.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class Tapa : NativeWindow {
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct Ajuste { public Guid Guid; public int Largo; public byte Dato; }

  static Guid LID = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
  const int WM_POWERBROADCAST = 0x0218;
  const int PBT_POWERSETTINGCHANGE = 0x8013;

  public Tapa() {
    CreateHandle(new CreateParams());
    RegisterPowerSettingNotification(Handle, ref LID, 0);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_POWERBROADCAST && (int)m.WParam == PBT_POWERSETTINGCHANGE) {
      var a = (Ajuste)Marshal.PtrToStructure(m.LParam, typeof(Ajuste));
      if (a.Guid == LID) Console.Out.WriteLine("lid " + a.Dato);
      Console.Out.Flush();
    }
    base.WndProc(ref m);
  }
}
'@
$tapa = New-Object Tapa
# Si la app se cierra, se cierra el stdin: el ayudante se va con ella.
$lector = [System.IO.StreamReader]::new([Console]::OpenStandardInput())
$tarea = $lector.ReadLineAsync()
while (-not $tarea.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200 }
