plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.rizumu85.kotomimi.node"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "io.github.rizumu85.kotomimi.node"
        minSdk {
            version = release(28)
        }
        targetSdk {
            version = release(36)
        }
        versionCode = 2
        versionName = "0.2.0"
        ndk {
            // The engine is built for 64-bit ARM alone (scripts/build-engine.sh).
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            // The engine is a program the app starts, not a library it loads: it has to be a file on disk, which
            // Android gives only when the libraries are unpacked at install.
            useLegacyPackaging = true
            // Its symbols are stripped by the script already; AGP's own strip does not know these files.
            keepDebugSymbols += "**/*.so"
        }
    }
}
