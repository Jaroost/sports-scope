// Déclarations minimales de l'API Web Bluetooth — juste ce que variaRadar.ts
// utilise. Évite d'ajouter @types/web-bluetooth pour un simple POC. Si on
// pérennise la fonctionnalité, remplacer ce fichier par `pnpm add -D
// @types/web-bluetooth` et l'ajouter à `types` dans tsconfig.

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>
}

interface BluetoothDevice extends EventTarget {
  readonly id: string
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
}

interface RequestDeviceOptions {
  filters?: Array<{ services?: string[]; name?: string; namePrefix?: string }>
  optionalServices?: string[]
  acceptAllDevices?: boolean
}

interface Bluetooth {
  getAvailability(): Promise<boolean>
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>
}

interface Navigator {
  readonly bluetooth?: Bluetooth
}
