import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 正式签名的密钥不进仓库：android/keystore.properties（storeFile、storePassword、keyAlias、keyPassword）
val keystore = Properties().apply {
    val f = rootProject.file("keystore.properties")
    // 路径里可能有中文，按 UTF-8 读
    if (f.exists()) f.reader(Charsets.UTF_8).use { load(it) }
}

android {
    namespace = "com.leo.lookask"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.leo.lookask"
        // 手柄的震动、电量、陀螺仪都要 Android 12 的 InputDevice 接口
        minSdk = 31
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.2"
    }

    signingConfigs {
        if (keystore.isNotEmpty()) {
            create("release") {
                storeFile = file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            // JNA 靠反射找接口方法，不做混淆
            isMinifyEnabled = false
            if (keystore.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { jvmToolchain(17) }

    // 模型和 wasm 不压缩，WebView 读得快
    androidResources { noCompress += listOf("wasm", "task", "bcmap", "pfb", "ttf") }
    packaging { resources.excludes += "META-INF/*" }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Java 的 USB 接口没有等时传输，USB 摄像头要直接调 ioctl；用 JNA 省掉 NDK
    implementation("net.java.dev.jna:jna:5.17.0@aar")
}
