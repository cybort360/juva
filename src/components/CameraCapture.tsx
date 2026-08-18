import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { JuvaButton } from '@/components/JuvaButton';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';

interface CameraCaptureProps {
  title: string;
  hint: string;
  onCapture: (photo: CameraCapturedPicture) => void;
}

export function CameraCapture({ title, hint, onCapture }: CameraCaptureProps) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setActive(true);
      return () => setActive(false);
    }, []),
  );

  if (!permission) return <View style={styles.loading} />;

  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.permissionTitle}>Camera access is required</Text>
        <Text style={styles.permissionCopy}>
          Juva only photographs prices and receipts when you press the shutter.
        </Text>
        <JuvaButton label="Allow camera" onPress={() => void requestPermission()} />
      </View>
    );
  }

  const takePhoto = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({
        quality: 0.68,
        base64: true,
        skipProcessing: false,
      });
      if (photo) onCapture(photo);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        active={active}
        animateShutter
        onCameraReady={() => setReady(true)}
      />
      <View style={styles.scrim} />
      <View style={styles.topCopy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <View style={styles.frame}>
        <View style={[styles.corner, styles.topLeft]} />
        <View style={[styles.corner, styles.topRight]} />
        <View style={[styles.corner, styles.bottomLeft]} />
        <View style={[styles.corner, styles.bottomRight]} />
      </View>
      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          onPress={() => void takePhoto()}
          style={({ pressed }) => [styles.shutterOuter, pressed && styles.pressed]}
        >
          <View style={styles.shutterInner} />
        </Pressable>
        <Text style={styles.ready}>
          {busy ? 'Capturing…' : ready ? 'Hold steady' : 'Starting camera…'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  loading: { flex: 1, backgroundColor: colors.paper },
  permission: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
    backgroundColor: colors.paper,
  },
  permissionTitle: { fontSize: 28, fontWeight: '800', color: colors.ink },
  permissionCopy: { fontSize: 16, lineHeight: 23, color: colors.muted },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.cameraOverlay },
  topCopy: { position: 'absolute', top: 68, left: 24, right: 24, alignItems: 'center', gap: 8 },
  title: { color: '#fff', fontSize: 25, fontWeight: '800', textAlign: 'center' },
  hint: { color: 'rgba(255,255,255,0.82)', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  frame: {
    position: 'absolute',
    left: 28,
    right: 28,
    top: '25%',
    height: '39%',
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  corner: { position: 'absolute', width: 44, height: 44, borderColor: colors.signal },
  topLeft: { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4, borderTopLeftRadius: 20 },
  topRight: { right: 0, top: 0, borderRightWidth: 4, borderTopWidth: 4, borderTopRightRadius: 20 },
  bottomLeft: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 4,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 20,
  },
  bottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 20,
  },
  controls: { position: 'absolute', bottom: 45, left: 0, right: 0, alignItems: 'center', gap: 12 },
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  pressed: { transform: [{ scale: 0.96 }] },
  ready: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
