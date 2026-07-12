# Outline Electron Client

Self-hosted Outline 서버를 그대로 로드하는 Electron 데스크톱 클라이언트 실험 프로젝트입니다. 기존 `outline-selfhost/`는 수정하지 않고, Electron preload 레이어에서 `/회의` 명령 감지, 회의 녹음 패널, 마이크 + 시스템 오디오 캡처, mock 실시간 전사 구조를 제공합니다.

## 프로젝트 구조

```text
outline-electron-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── main/
│   │   └── index.ts
│   ├── preload/
│   │   ├── index.ts
│   │   ├── audio/
│   │   │   └── audio-capture.ts
│   │   ├── meeting/
│   │   │   ├── command-detector.ts
│   │   │   ├── editor-bridge.ts
│   │   │   ├── meeting-controller.ts
│   │   │   └── meeting-panel.ts
│   │   ├── styles/
│   │   │   └── meeting-panel-styles.ts
│   │   └── transcription/
│   │       ├── mock-transcription-provider.ts
│   │       └── types.ts
│   └── shared/
│       └── ipc.ts
└── README.md
```

## 설계 요약

- Electron `BrowserWindow`가 기본 Outline URL인 `https://tukadlab.ignorelist.com`을 로드합니다.
- `nodeIntegration`은 끄고 `contextIsolation`과 renderer `sandbox`는 켠 상태로 동작합니다.
- Outline 서버 코드는 수정하지 않고 preload script가 DOM 이벤트를 관찰합니다.
- `/회의` 감지는 `src/preload/meeting/command-detector.ts`에 격리했습니다.
- 회의 UI는 Shadow DOM 기반 작은 패널로 주입되어 Outline 스타일과 충돌을 줄입니다.
- 녹음은 `getUserMedia` 마이크와 `getDisplayMedia` 시스템 오디오를 Web Audio API로 믹싱합니다.
- 전사는 `TranscriptionProvider` 인터페이스 뒤에 숨겼고, 현재는 mock provider가 chunk 단위 이벤트를 흉내 냅니다.
- 전사 삽입은 `EditorBridge`를 통해 현재 Outline 편집 영역에 plain text로 넣는 구조입니다.

## 실행 방법

```bash
cd outline-electron-client
npm install
npm run dev
```

다른 Outline 서버를 테스트하려면:

```bash
OUTLINE_URL=https://your-outline.example.com npm run dev
```

또는 빌드 후 직접 실행할 수 있습니다.

```bash
npm run build
npm start
```

> 참고: preload는 `sandbox: true` 환경에서 로컬 파일 `require`가 불가능하므로, 빌드 시 esbuild로 `dist/preload/index.js` 단일 파일로 번들됩니다(`npm run bundle:preload`가 `build`에 포함). `tsc`만 단독 실행해 preload 출력을 덮어쓰면 preload 로드가 실패하고 `/회의` 감지가 동작하지 않으니 반드시 `npm run build`를 사용하세요.

Linux 컨테이너나 일부 제한된 개발 환경에서 Electron이 `chrome-sandbox` 권한 오류로 바로 종료되면, 로컬 개발 검증에 한해 `electron --no-sandbox .` 실행이 필요할 수 있습니다. 배포용 기본 설정은 sandbox를 유지하는 방향을 권장합니다.

## 이메일 로그인 링크 처리

Outline의 이메일 로그인 링크는 기본적으로 `https://tukadlab.ignorelist.com/...` 형태입니다. Windows에서 이 링크를 메일 앱에서 그냥 클릭하면 OS 기본 브라우저가 열리고, Electron 앱의 별도 세션에는 로그인 쿠키가 저장되지 않습니다.

현재 앱은 두 가지 보완 흐름을 지원합니다.

### 1. 지금 바로 쓸 수 있는 흐름

1. Electron 앱에서 이메일 로그인을 요청합니다.
2. 메일에서 Outline 로그인 링크를 우클릭해 링크 주소를 복사합니다.
3. Electron 앱으로 돌아와 `Ctrl+Shift+L`을 누르거나 `Authentication` → `Open login link from clipboard` 메뉴를 선택합니다.
4. 앱이 클립보드의 `https://tukadlab.ignorelist.com/...` 로그인 링크를 Electron 내부 세션으로 로드합니다.

### 2. 딥링크 기반 원클릭 흐름

앱은 `outline-electron://` 커스텀 프로토콜을 등록하고 다음 형태의 링크를 처리합니다.

```text
outline-electron://open?url=https%3A%2F%2Ftukadlab.ignorelist.com%2Fauth%2Femail.callback%3F...
```

이 링크가 열리면 앱은 `url` 파라미터 안의 Outline URL이 현재 서버 origin과 같은지 검증한 뒤 Electron 창에서 로드합니다.

다만 기존 Outline 서버가 계속 `https://...` 이메일 링크만 보내는 한, Windows가 해당 링크를 Electron 앱으로 자동 전달하지는 않습니다. 진짜 “메일 링크 클릭 → Electron 앱 열림”을 만들려면 다음 중 하나가 필요합니다.

- Outline 서버의 이메일 로그인 링크를 `outline-electron://open?url=...` 형태로 생성하거나 중간 리다이렉트 링크로 감싸기
- 패키징된 Windows 앱에서 MSIX App URI Handler 같은 방식으로 특정 HTTPS 도메인을 앱에 연결하기
- 사용자가 `https` 전체 기본 앱을 Electron으로 바꾸는 방식은 시스템 전체 브라우저 동작을 깨뜨리므로 권장하지 않음

개발 중 딥링크 등록 여부는 앱을 한 번 실행한 뒤 PowerShell에서 아래처럼 확인할 수 있습니다.

```powershell
Start-Process "outline-electron://open?url=https%3A%2F%2Ftukadlab.ignorelist.com%2F"
```

## 사용 흐름

1. Electron 앱에서 Outline 문서를 엽니다.
2. 문서 편집 영역에 `/회의`를 입력합니다.
3. 우측 하단 회의 녹음 패널이 뜹니다.
4. `시작`을 누르면 마이크 권한과 화면/시스템 오디오 권한을 요청합니다.
5. 녹음 중 mock 실시간 전사가 표시됩니다.
6. `중지` 후 `문서에 삽입`을 누르면 전사 텍스트가 현재 문서 편집 위치에 삽입됩니다.
7. `녹음 다운로드`로 mixed audio WebM 파일을 저장할 수 있습니다.

## 오디오 캡처 설계와 OS 제약

### Windows 우선 경로

- Electron main process에서 `session.setDisplayMediaRequestHandler`를 설정합니다.
- renderer/preload에서 `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`를 호출합니다.
- Windows에서는 Electron의 `audio: "loopback"` 경로로 시스템 오디오 캡처를 시도합니다.
- 마이크는 `getUserMedia({ audio: true })`로 별도 캡처합니다.
- 두 입력은 Web Audio API의 `MediaStreamAudioDestinationNode`로 믹싱하고 `MediaRecorder`로 저장합니다.

### macOS

- 화면 캡처는 macOS 권한 동의가 필요합니다.
- macOS 14.2+에서는 패키징 시 `NSAudioCaptureUsageDescription` 설정이 필요합니다.
- Electron/Chromium 버전과 서명 상태에 따라 시스템 오디오 스트림이 비어 있을 수 있습니다.
- 구버전 macOS나 제한 환경에서는 BlackHole 같은 가상 오디오 장치를 마이크 입력처럼 연결하는 우회가 필요할 수 있습니다.

### Linux

- PipeWire 환경에서는 source 선택이 제한될 수 있습니다.
- 배포판/데스크톱/포털 설정에 따라 시스템 오디오가 직접 오지 않을 수 있습니다.
- PulseAudio/PipeWire monitor source를 별도 입력 장치로 선택하는 설계가 필요할 수 있습니다.

## 전사 Provider 교체 지점

현재 구현:

- `src/preload/transcription/types.ts`: `TranscriptionProvider` 인터페이스
- `src/preload/transcription/mock-transcription-provider.ts`: mock 구현

나중에 추가하기 좋은 어댑터:

- OpenAI Realtime/WebSocket provider
- 서버 중계 WebSocket provider
- 로컬 Whisper/Vosk provider
- mixed audio와 mic/system separate track을 분리 업로드하는 provider

## 보안과 개인정보 UX

- 앱은 명시적으로 `시작` 버튼을 누른 뒤에만 녹음 권한을 요청합니다.
- 녹음 중 패널에 상태 표시와 빨간 indicator를 보여줍니다.
- mock provider는 네트워크로 오디오를 전송하지 않습니다.
- 실제 전사 provider를 붙일 때는 전송 대상, 보존 기간, 회의 참여자 동의 UX를 추가해야 합니다.
- preload는 필요한 브릿지만 노출하고 Node API를 웹 페이지에 직접 열지 않습니다.

## 다음 단계

- `/회의` 명령 텍스트를 자동으로 제거하거나 회의 블록으로 치환하기
- Outline ProseMirror 구조에 맞춘 더 안정적인 삽입 adapter 작성
- 시스템 오디오 source 선택 UI 추가
- mic/system separate track 저장 옵션 추가
- OpenAI 또는 로컬 Whisper provider 구현
- 녹음 중 pause/resume, duration, 레벨 미터 추가
- 패키징 설정과 macOS 권한 plist 구성 추가

## 참고한 Electron API

- [session.setDisplayMediaRequestHandler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [BrowserWindow webPreferences](https://www.electronjs.org/docs/latest/api/browser-window)
