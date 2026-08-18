import { router, Stack } from 'expo-router';

import { JuvaButton } from '@/components/JuvaButton';
import { JuvaStateScreen } from '@/components/JuvaStateScreen';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <JuvaStateScreen
        eyebrow="NOTHING ON THIS SHELF"
        title="That screen isn't part of Juva."
        copy="The link you followed doesn't match a Juva screen. Your basket, trip and verified savings are untouched."
        action={
          <JuvaButton
            label="Back to your basket"
            variant="dark"
            onPress={() => router.replace('/')}
          />
        }
      />
    </>
  );
}
