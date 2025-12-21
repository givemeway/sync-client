
#include <napi.h>
#include <windows.h>
#include <string>
#include <thread>
#include <vector>
#include <iostream>

// Helper to convert WCHAR* to UTF8 std::string
std::string WStringToString(const std::wstring& wstr) {
    if (wstr.empty()) return std::string();
    int size_needed = WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), NULL, 0, NULL, NULL);
    std::string strTo(size_needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), &strTo[0], size_needed, NULL, NULL);
    return strTo;
}

class Watcher : public Napi::ObjectWrap<Watcher> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    Watcher(const Napi::CallbackInfo& info);
    ~Watcher();

private:
    std::string path;
    Napi::ThreadSafeFunction tsfn;
    std::thread nativeThread;
    bool running;
    HANDLE hDir;

    void WatchLoop();
    void Stop();

    // JS Methods
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value StopJS(const Napi::CallbackInfo& info);
};

Napi::Object Watcher::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "Watcher", {
        InstanceMethod("start", &Watcher::Start),
        InstanceMethod("stop", &Watcher::StopJS)
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    exports.Set("Watcher", func);
    return exports;
}

Watcher::Watcher(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Watcher>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (path: string, callback: function)").ThrowAsJavaScriptException();
        return;
    }

    this->path = info[0].As<Napi::String>().Utf8Value();
    this->running = false;
    this->hDir = INVALID_HANDLE_VALUE;

    // Create ThreadSafeFunction to call JS from C++ thread
    this->tsfn = Napi::ThreadSafeFunction::New(
        env,
        info[1].As<Napi::Function>(),
        "WatcherCallback",
        0,
        1
    );
}

Watcher::~Watcher() {
    this->Stop();
}

void Watcher::Stop() {
    this->running = false;
    if (this->hDir != INVALID_HANDLE_VALUE) {
        CancelIoEx(this->hDir, NULL);
        CloseHandle(this->hDir);
        this->hDir = INVALID_HANDLE_VALUE;
    }
    if (this->nativeThread.joinable()) {
        this->nativeThread.join();
    }
    this->tsfn.Release();
}

Napi::Value Watcher::StopJS(const Napi::CallbackInfo& info) {
    this->Stop();
    return info.Env().Undefined();
}

Napi::Value Watcher::Start(const Napi::CallbackInfo& info) {
    if (this->running) return info.Env().Undefined();
    this->running = true;
    this->nativeThread = std::thread(&Watcher::WatchLoop, this);
    return info.Env().Undefined();
}

void Watcher::WatchLoop() {
    // 1. Open Directory Handle
    std::wstring wpath(this->path.begin(), this->path.end()); // Simple conversion (ASCII only for now, improve later)
    
    // Better conversion for path
    int size_needed = MultiByteToWideChar(CP_UTF8, 0, &this->path[0], (int)this->path.size(), NULL, 0);
    std::wstring wstrTo(size_needed, 0);
    MultiByteToWideChar(CP_UTF8, 0, &this->path[0], (int)this->path.size(), &wstrTo[0], size_needed);
    
    this->hDir = CreateFileW(
        wstrTo.c_str(),
        FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
        NULL
    );

    if (this->hDir == INVALID_HANDLE_VALUE) {
        // Error
        return;
    }

    char buffer[1024 * 64]; // 64KB Buffer
    DWORD bytesReturned;
    OVERLAPPED overlapped = { 0 };
    overlapped.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);

    while (this->running) {
        BOOL success = ReadDirectoryChangesW(
            this->hDir,
            buffer,
            sizeof(buffer),
            TRUE, // Recursive
            FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION,
            &bytesReturned,
            &overlapped,
            NULL
        );

        if (!success) {
             // Basic error handling
             break;
        }

        DWORD waitResult = WaitForSingleObject(overlapped.hEvent, 500); // Check every 500ms
        if (waitResult == WAIT_TIMEOUT) {
            continue; 
        }

        if (GetOverlappedResult(this->hDir, &overlapped, &bytesReturned, FALSE)) {
             if (bytesReturned == 0) continue;

             FILE_NOTIFY_INFORMATION* pNotify;
             int offset = 0;
             pNotify = (FILE_NOTIFY_INFORMATION*)buffer;

             do {
                 std::wstring wfilename(pNotify->FileName, pNotify->FileNameLength / sizeof(WCHAR));
                 std::string filename = WStringToString(wfilename);
                 int action = pNotify->Action;

                 // Send to JS
                 auto callback = [filename, action](Napi::Env env, Napi::Function jsCallback) {
                     Napi::Object obj = Napi::Object::New(env);
                     obj.Set("filename", filename);
                     obj.Set("action", action); // 1=Add, 2=Remove, 3=Mod, 4=RenOld, 5=RenNew
                     jsCallback.Call({ obj });
                 };
                 this->tsfn.NonBlockingCall(callback);

                 offset = pNotify->NextEntryOffset;
                 pNotify = (FILE_NOTIFY_INFORMATION*)((char*)pNotify + offset);
             } while (offset != 0);
             
             ResetEvent(overlapped.hEvent);
        }
    }
    CloseHandle(overlapped.hEvent);
}

// Module Init
Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return Watcher::Init(env, exports);
}

NODE_API_MODULE(watcher, InitAll)
