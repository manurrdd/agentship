plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.habit.tracker"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.habit.tracker"
        minSdk = 26
        targetSdk = 35
        versionCode = 7
        versionName = "3.1.0"
    }

    flavorDimensions += "tier"
    productFlavors {
        create("free") {
            dimension = "tier"
            applicationIdSuffix = ".free"
        }
        create("pro") {
            dimension = "tier"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
        }
        debug {
            isDebuggable = true
        }
    }
}

dependencies {
    implementation("com.android.billingclient:billing:7.0.0")
    implementation("com.google.android.gms:play-services-ads:23.3.0")
    implementation("com.google.firebase:firebase-crashlytics:19.0.0")
}
