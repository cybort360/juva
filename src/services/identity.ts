import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const USER_ID_KEY = 'juva.revenuecat.user-id.v1';

/**
 * A stable, anonymous app user id for RevenueCat.
 *
 * SecureStore has no web implementation, so web falls back to AsyncStorage.
 * The value is a random UUID and is never derived from device identifiers.
 */
async function readStored(): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(USER_ID_KEY);
  return SecureStore.getItemAsync(USER_ID_KEY);
}

async function writeStored(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(USER_ID_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(USER_ID_KEY, value);
}

export async function getOrCreateAppUserId(): Promise<string> {
  const existing = await readStored();
  if (existing) return existing;

  const generated = `juva_${Crypto.randomUUID()}`;
  await writeStored(generated);
  return generated;
}
