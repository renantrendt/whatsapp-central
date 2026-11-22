plugins {
    id("com.android.application")
}

android {
    namespace = "app.whatsappcentral"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "app.whatsappcentral"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // O nodejs-mobile só traz o motor para estes processadores. O Pixel usa arm64.
        ndk { abiFilters += listOf("arm64-v8a") }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                // O libnode.so precisa da biblioteca C++ compartilhada dentro do app.
                arguments += "-DANDROID_STL=c++_shared"
                // Alinha a nossa biblioteca nativa às páginas de memória de 16 KB do Android novo.
                arguments += "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        // Versão normal (não "debug"): sem o aviso de app em teste. Assinada com a
        // chave local de desenvolvimento, porque o app é instalado direto pelo cabo.
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // O código do servidor vai num zip; não comprimir de novo.
    androidResources { noCompress += "zip" }
    packaging { jniLibs { useLegacyPackaging = true } }
}
